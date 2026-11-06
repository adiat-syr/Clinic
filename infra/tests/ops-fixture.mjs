// Runs ONLY in the isolated staging test container. Never against an existing database.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import * as OTPAuth from 'otpauth';
import { secret, identifier, log } from '../ops/lib.mjs';
import { bootstrap, migrate, grants } from '../ops/database.mjs';
import { rotateKeys } from '../ops/rotation.mjs';
import { createPrisma } from '../../apps/api/dist/infrastructure/prisma.js';
import { verifyRuntimeDatabase } from '../../apps/api/dist/infrastructure/runtime-check.js';
import { seedSyntheticClinic, syntheticIds } from '../../apps/api/dist/testing/synthetic-clinic.js';
import { BookingHttpService } from '../../apps/api/dist/modules/booking/http-service.js';
import { AuthService } from '../../apps/api/dist/modules/security/service.js';
import { parseSecurityEnvironment } from '../../apps/api/dist/modules/security/config.js';
import { parsePrivacyEnvironment } from '../../apps/api/dist/modules/booking/privacy.js';
import { CatalogService } from '../../apps/api/dist/modules/catalog/service.js';

const root = '/drill',
  name = 'clinic_test_' + randomBytes(16).toString('hex');
await mkdir(root, { recursive: true, mode: 0o700 });
const adminUrl = await secret('BOOTSTRAP_DATABASE_URL'),
  admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`CREATE DATABASE ${identifier(name)} OWNER clinic_migrator`);
const state = { name, restoreName: 'clinic_test_' + randomBytes(16).toString('hex') };
await writeFile(join(root, 'state.json'), JSON.stringify(state), { mode: 0o600 });
for (const [variable, file] of Object.entries({
  BOOTSTRAP_DATABASE_URL: 'bootstrap_url',
  MIGRATION_DATABASE_URL: 'migrator_url',
  DATABASE_URL: 'runtime_url',
  OPERATOR_DATABASE_URL: 'operator_url',
  MAINTENANCE_DATABASE_URL: 'maintenance_url',
  BACKUP_DATABASE_URL: 'backup_url',
  RESTORE_ADMIN_URL: 'bootstrap_url',
})) {
  const original = await readFile('/run/secrets/' + file, 'utf8'),
    url = new URL(original.trim());
  if (variable !== 'RESTORE_ADMIN_URL') url.pathname = '/' + name;
  const path = join(root, variable.toLowerCase());
  await writeFile(path, url.toString(), { mode: 0o600 });
  process.env[variable + '_FILE'] = path;
  delete process.env[variable];
}
await bootstrap();
await migrate();
await grants();
const migrator = createPrisma(
  (await readFile(process.env.MIGRATION_DATABASE_URL_FILE, 'utf8')).trim(),
);
const day = new Date();
day.setUTCDate(day.getUTCDate() + 1);
await seedSyntheticClinic(migrator, day, new Date(Date.now() - 120000));
await migrator.$disconnect();
for (const key of [
  'AUTH_MFA_KEY',
  'AUTH_MFA_KEYS_JSON',
  'AUTH_CSRF_KEY',
  'CONTACT_KEYS_JSON',
  'BOOKING_HMAC_KEY',
])
  process.env[key] = await secret(key);
const security = parseSecurityEnvironment(process.env),
  privacy = parsePrivacyEnvironment(process.env);
let now = new Date(Date.now() - (process.env.HTTPS_FIXTURE === '1' ? 60000 : 0));
const clock = () => now;
const runtime = createPrisma(await secret('DATABASE_URL'));
const operator = createPrisma(await secret('OPERATOR_DATABASE_URL'));

const operatorAuth = new AuthService(operator, security, clock),
  auth = new AuthService(runtime, security, clock),
  booking = new BookingHttpService(runtime, privacy, clock);
const password = randomBytes(24).toString('base64url'),
  mfa = new OTPAuth.Secret({ size: 20 }).base32,
  email = 'synthetic-ops-' + randomUUID() + '@example.invalid';
const code = () =>
  new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(mfa),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate({ timestamp: now.getTime() });
try {
  await verifyRuntimeDatabase(runtime);
  const staff = (await operatorAuth.bootstrap({ email, password, mfaSecret: mfa, code: code() }))
    .id;
  now = new Date(now.getTime() + 30000);
  const challenge = await auth.login({ email, password }, '192.0.2.20', randomUUID(), null);
  const session = (
    await auth.verifyMfa(challenge.token, { code: code() }, '192.0.2.20', randomUUID())
  ).token;
  await assert.rejects(auth.me(challenge.token, randomUUID()), (e) => e.code === 'UNAUTHORIZED');
  assert.equal((await auth.me(session, randomUUID())).role, 'ADMIN');
  const catalog = new CatalogService(runtime);
  assert.ok((await catalog.doctors({ page: 1, pageSize: 100 })).items.length > 0);
  const selection = {
    doctorId: syntheticIds.doctors[0],
    serviceId: syntheticIds.services[0],
    date: day.toISOString().slice(0, 10),
  };
  const availability = await booking.availability(selection);
  assert.ok(availability.slots.length >= 2);
  const consent = { documentId: syntheticIds.consent, locale: 'ru', accepted: true };
  const contacts = { name: 'Синтетический посетитель для восстановления', phone: '+70000009999' };
  const chosen = {
    doctorId: selection.doctorId,
    serviceId: selection.serviceId,
    startsAt: availability.slots[0].startsAt,
    expectedPriceKzt: availability.priceKzt,
    expectedDurationMinutes: availability.durationMinutes,
  };
  const first = await booking.create(
    { ...chosen, contacts, consent },
    randomBytes(16).toString('hex'),
  );
  const id = (
    await runtime.appointment.findUniqueOrThrow({ where: { reference: first.body.reference } })
  ).id;
  const receipt = await booking.issueConsentCode({ contacts, consent });
  const second = await auth.withSession(session, { requestId: randomUUID() }, (tx, actor) =>
    booking.staffCreate(
      tx,
      {
        ...chosen,
        startsAt: availability.slots.find(
          (s) =>
            Date.parse(s.startsAt) >=
            Date.parse(availability.slots[0].startsAt) + availability.durationMinutes * 60000,
        ).startsAt,
        consentCode: receipt.code,
      },
      randomBytes(16).toString('hex'),
      actor.id,
      randomUUID(),
    ),
  );
  assert.equal(second.body.status, 'PENDING');
  const manualId = (
    await runtime.appointment.findUniqueOrThrow({ where: { reference: second.body.reference } })
  ).id;
  await auth.withSession(session, { requestId: randomUUID() }, (tx, actor) =>
    booking.withdraw(tx, manualId, { version: 1, confirmedIdentity: true }, actor.id, randomUUID()),
  );
  await auth.withSession(session, { requestId: randomUUID() }, (tx, actor) =>
    booking.withdraw(tx, id, { version: 1, confirmedIdentity: true }, actor.id, randomUUID()),
  );
  await booking.issueConsentCode({ contacts, consent }); // unclaimed receipt must rotate too
  const third = await booking.create(
    {
      ...chosen,
      startsAt: availability.slots.find(
        (s) =>
          Date.parse(s.startsAt) >=
          Date.parse(availability.slots[0].startsAt) + 2 * availability.durationMinutes * 60000,
      ).startsAt,
      contacts,
      consent,
    },
    randomBytes(16).toString('hex'),
  );
  const withdrawalOnlyId = (
    await runtime.appointment.findUniqueOrThrow({ where: { reference: third.body.reference } })
  ).id;
  const runtimePg = new pg.Pool({ connectionString: await secret('DATABASE_URL'), max: 1 });
  try {
    for (const sql of [
      'CREATE TABLE forbidden_test(id int)',
      'TRUNCATE appointments',
      "UPDATE audit_events SET action='FORGED'",
      'DELETE FROM bootstrap_state',
      "UPDATE consent_documents SET text_ru='forged'",
      "UPDATE patient_consent_receipts SET patient_name_ciphertext='forged'",
      'SET ROLE clinic_migrator',
    ])
      await assert.rejects(runtimePg.query(sql), (e) => e.code === '42501');
  } finally {
    await runtimePg.end();
  }
  if (process.env.HTTPS_FIXTURE === '1') {
    Object.assign(state, {
      email,
      password,
      mfa,
      date: day.toISOString().slice(0, 10),
      appointmentId: id,
      manualId,
      staffId: staff,
    });
    await writeFile(join(root, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    log('https_fixture_prepared', { syntheticOnly: true });
  } else {
    const oldPrivacy = privacy.keys[privacy.activeVersion];
    assert.ok(oldPrivacy);
    const contactsRing = JSON.parse(process.env.CONTACT_KEYS_JSON),
      mfaRing = JSON.parse(process.env.AUTH_MFA_KEYS_JSON);
    contactsRing.v2 = randomBytes(32).toString('hex');
    mfaRing.v2 = randomBytes(32).toString('hex');
    process.env.CONTACT_KEYS_JSON = JSON.stringify(contactsRing);
    process.env.AUTH_MFA_KEYS_JSON = JSON.stringify(mfaRing);
    process.env.CONTACT_KEY_VERSION = 'v2';
    process.env.AUTH_MFA_ACTIVE_VERSION = 'v2';
    process.env.DATABASE_URL_FILE = process.env.MAINTENANCE_DATABASE_URL_FILE;
    delete process.env.DATABASE_URL;
    const rotated = await rotateKeys();
    assert.equal(rotated.contactCount, 5);
    assert.equal(rotated.mfaCount, 1);
    const again = await rotateKeys();
    assert.deepEqual(again, { contactCount: 0, mfaCount: 0 });
    await assert.rejects(auth.me(session, randomUUID()), (e) => e.code === 'UNAUTHORIZED');
    const row = await runtime.appointment.findUniqueOrThrow({ where: { id } });
    assert.equal(row.encryptionKeyVersion, 'v2');
    const { ContactPrivacy } = await import('../../apps/api/dist/modules/booking/privacy.js');
    const updated = new ContactPrivacy(parsePrivacyEnvironment(process.env));
    assert.equal(updated.open(row.patientNameCiphertext, 'v2', 'name'), contacts.name);
    const rotatedAuth = new AuthService(runtime, parseSecurityEnvironment(process.env), clock);
    now = new Date(now.getTime() + 30000);
    const freshChallenge = await rotatedAuth.login(
      { email, password },
      '192.0.2.21',
      randomUUID(),
      null,
    );
    const freshSession = await rotatedAuth.verifyMfa(
      freshChallenge.token,
      { code: code() },
      '192.0.2.21',
      randomUUID(),
    );
    const negativeLogMarker = 'synthetic-log-marker-' + randomUUID() + '@example.invalid';
    // Duplicate error must not cause PostgreSQL to log submitted email DETAIL.
    await operator.staffUser.create({
      data: { email: negativeLogMarker, passwordHash: 'DISABLED', role: 'RECEPTIONIST' },
    });
    await assert.rejects(
      operator.staffUser.create({
        data: { email: negativeLogMarker, passwordHash: 'DISABLED', role: 'RECEPTIONIST' },
      }),
    );
    Object.assign(state, {
      appointmentId: id,
      staffId: staff,
      manualId,
      withdrawalOnlyId,
      sessionToken: freshSession.token,
      clock: now.toISOString(),
      negativeLogMarker,
      roleChecks: 7,
      rotation: rotated,
      maintenanceUrlFile: join(root, 'maintenance_database_url'),
    });
    await writeFile(join(root, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    await writeFile(
      join(root, 'policy.json'),
      JSON.stringify({
        approved: false,
        decisionReference: 'synthetic-drill',
        technicalGraceSeconds: 1,
        backupRetentionDays: 30,
        withdrawalErasureApproved: true,
      }),
      { mode: 0o600 },
    );
    // Only disposable test credentials persist inside the ignored private drill directory.
    await writeFile(join(root, 'rotation-keys.json'), JSON.stringify({ contactsRing, mfaRing }), {
      mode: 0o600,
    });
    log('ops_fixture_verified', {
      roleChecks: 7,
      sharedBooking: true,
      mfaRotationIdempotent: true,
      source: name,
    });
  }
} finally {
  await Promise.all([runtime.$disconnect(), operator.$disconnect(), admin.end()]);
}
