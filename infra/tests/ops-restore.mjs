import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { backup, restore, finalizeRestore } from '../ops/backup.mjs';
import { anonymize, cleanup, checkIntegrity, replayLedger } from '../ops/maintenance.mjs';
import { ledgerSnapshot, reconcileLedger, rotateLedgerKey } from '../ops/ledger.mjs';
import { database, identifier, log } from '../ops/lib.mjs';
import { secret } from '../ops/lib.mjs';
import { createWithdrawalJournal } from '../ops/withdrawal.mjs';

const root = '/drill',
  state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
if (
  !/^clinic_test_[a-f0-9]{32}$/.test(state.name) ||
  !/^clinic_test_[a-f0-9]{32}$/.test(state.restoreName)
)
  throw new Error('OWNED_TEST_DATABASE_REQUIRED');
for (const name of ['backups', 'secondary', 'ledger', 'checkpoint'])
  await mkdir(join(root, name), { recursive: true, mode: 0o700 });
const admin = await database('RESTORE_ADMIN_URL'),
  db = await database(),
  targets = [state.name, state.restoreName];
let assertions = 0;
const check = (value) => {
  assert.ok(value);
  assertions++;
};
try {
  await ledgerSnapshot({ initialize: true });
  const initialLedger = await readFile(join(root, 'ledger/registry.json'));
  await cleanup();
  check(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM appointments WHERE patient_name_ciphertext IS NOT NULL',
      )
    ).rows[0].n === 3,
  );
  await assert.rejects(anonymize(state.appointmentId), /APPROVED_POLICY_REQUIRED/);
  assertions++;
  const archive = await backup(),
    file = basename(archive);
  // Real AuthService + booking service, approved withdrawal AFTER the dump, no erasure policy.
  const { createPrisma } = await import('../../apps/api/dist/infrastructure/prisma.js');
  const { AuthService } = await import('../../apps/api/dist/modules/security/service.js');
  const { BookingHttpService } =
    await import('../../apps/api/dist/modules/booking/http-service.js');
  const { parseSecurityEnvironment } =
    await import('../../apps/api/dist/modules/security/config.js');
  const { parsePrivacyEnvironment } =
    await import('../../apps/api/dist/modules/booking/privacy.js');
  const rings = JSON.parse(await readFile(join(root, 'rotation-keys.json'), 'utf8'));
  const configuration = {
    NODE_ENV: 'test',
    AUTH_ORIGIN: 'https://clinic.example.test',
    AUTH_MFA_KEY: await secret('AUTH_MFA_KEY'),
    AUTH_MFA_KEYS_JSON: JSON.stringify(rings.mfaRing),
    AUTH_MFA_ACTIVE_VERSION: 'v2',
    AUTH_CSRF_KEY: await secret('AUTH_CSRF_KEY'),
    CONTACT_KEYS_JSON: JSON.stringify(rings.contactsRing),
    CONTACT_KEY_VERSION: 'v2',
    BOOKING_HMAC_KEY: await secret('BOOKING_HMAC_KEY'),
    CLINIC_TIME_ZONE: 'Asia/Almaty',
  };
  const runtime = createPrisma((await readFile(join(root, 'database_url'), 'utf8')).trim());
  try {
    const clock = () => new Date(state.clock),
      auth = new AuthService(runtime, parseSecurityEnvironment(configuration), clock),
      booking = new BookingHttpService(runtime, parsePrivacyEnvironment(configuration), clock);
    booking.withdrawalJournal = createWithdrawalJournal();
    await assert.rejects(
      booking.withWithdrawalLock(() =>
        auth.withSession(
          state.sessionToken,
          { requestId: crypto.randomUUID(), roles: ['ADMIN'] },
          async (tx, actor) => {
            await booking.withdraw(
              tx,
              state.withdrawalOnlyId,
              { version: 1, confirmedIdentity: true },
              actor.id,
              crypto.randomUUID(),
            );
            throw new Error('SYNTHETIC_AFTER_JOURNAL_ROLLBACK');
          },
        ),
      ),
    );
    check(
      (
        await runtime.appointmentConsent.findUniqueOrThrow({
          where: { appointmentId: state.withdrawalOnlyId },
        })
      ).withdrawnAt === null,
    );
    const { reconcilePrivacy } = await import('../ops/reconcile-privacy.mjs');
    check((await reconcilePrivacy()).applied === 1);
    check((await reconcilePrivacy()).applied === 0);
    const record = await runtime.appointment.findUniqueOrThrow({
      where: { id: state.withdrawalOnlyId },
      include: { consent: true },
    });
    check(record.consent.withdrawnAt !== null && record.patientNameCiphertext !== null);
  } finally {
    await runtime.$disconnect();
  }
  check((await readFile(join(root, 'secondary', file))).equals(await readFile(archive)));
  const raw = await readFile(archive);
  check(!raw.includes(Buffer.from('Синтетический посетитель')));
  const policy = JSON.parse(await readFile(process.env.RETENTION_POLICY_FILE, 'utf8'));
  policy.approved = true;
  await writeFile(process.env.RETENTION_POLICY_FILE, JSON.stringify(policy));
  check(await anonymize(state.appointmentId));
  check(!(await anonymize(state.appointmentId)));
  check(
    (await db.query('SELECT anonymized_at FROM appointments WHERE id=$1', [state.appointmentId]))
      .rows[0].anonymized_at !== null,
  );
  const manifestPath = archive + '.json',
    originalManifest = await readFile(manifestPath),
    manifest = JSON.parse(originalManifest);
  manifest.ledgerCount = 0;
  manifest.ledgerPrefix = '0'.repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restore(file, state.restoreName), /ARCHIVE_CHECKSUM_FAILED/);
  assertions++;
  check(
    (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [state.restoreName]))
      .rowCount === 0,
  );
  await writeFile(manifestPath, originalManifest);
  await writeFile(join(root, 'ledger/registry.json'), initialLedger);
  await assert.rejects(restore(file, state.restoreName), /LATEST_LEDGER_CHECKPOINT_MISMATCH/);
  assertions++;
  await reconcileLedger();
  await rm(join(root, 'checkpoint/registry.json'));
  await assert.rejects(restore(file, state.restoreName), { code: 'ENOENT' });
  assertions++;
  await reconcileLedger();
  const bad = Buffer.from(raw);
  bad[40] ^= 1;
  await writeFile(archive, bad);
  await assert.rejects(restore(file, state.restoreName), /ARCHIVE_CHECKSUM_FAILED/);
  assertions++;
  await writeFile(archive, raw);
  const ledgerRing = JSON.parse(await readFile(process.env.DELETION_LEDGER_KEYS_JSON_FILE, 'utf8'));
  ledgerRing.v2 = randomBytes(32).toString('hex');
  await writeFile(join(root, 'ledger-keys-v2'), JSON.stringify(ledgerRing));
  process.env.DELETION_LEDGER_KEYS_JSON_FILE = join(root, 'ledger-keys-v2');
  process.env.DELETION_LEDGER_KEY_VERSION = 'v2';
  check((await rotateLedgerKey()).changed);
  check(!(await rotateLedgerKey()).changed);
  const ring = JSON.parse(await readFile(process.env.BACKUP_KEYS_JSON_FILE, 'utf8'));
  ring.v2 = randomBytes(32).toString('hex');
  await writeFile(join(root, 'backup-keys-v2'), JSON.stringify(ring));
  process.env.BACKUP_KEYS_JSON_FILE = join(root, 'backup-keys-v2');
  process.env.BACKUP_KEY_VERSION = 'v2';
  await restore(file, state.restoreName);
  const restoredUrl = new URL(await readFile('/run/secrets/bootstrap_url', 'utf8'));
  restoredUrl.pathname = '/' + state.restoreName;
  const pg = await import('pg'),
    restored = new pg.default.Pool({ connectionString: restoredUrl.toString(), max: 1 });
  try {
    check((await restored.query('SELECT count(*)::int AS n FROM staff_sessions')).rows[0].n === 0);
    check(
      (
        await restored.query(
          "SELECT count(*)::int AS n FROM staff_users WHERE is_active OR mfa_enabled OR password_hash<>'RESTORE_QUARANTINED'",
        )
      ).rows[0].n === 0,
    );
    const integrity = await checkIntegrity(restored);
    check(integrity.appointments === 3 && integrity.consents === 3);
    const row = (
      await restored.query(
        'SELECT patient_name_ciphertext,phone_ciphertext,anonymized_at FROM appointments WHERE id=$1',
        [state.appointmentId],
      )
    ).rows[0];
    check(
      row.patient_name_ciphertext === null &&
        row.phone_ciphertext === null &&
        row.anonymized_at !== null,
    );
    check(
      (
        await restored.query(
          'SELECT count(*)::int AS n FROM appointments WHERE patient_name_ciphertext IS NOT NULL',
        )
      ).rows[0].n === 2,
    );
    const withdrawal = (
      await restored.query(
        'SELECT c.withdrawn_at,a.patient_name_ciphertext FROM appointment_consents c JOIN appointments a ON a.id=c.appointment_id WHERE a.id=$1',
        [state.withdrawalOnlyId],
      )
    ).rows[0];
    check(withdrawal.withdrawn_at !== null && withdrawal.patient_name_ciphertext !== null);
    check((await replayLedger(restored)) === 0);
    await assert.rejects(restore(file, state.restoreName), /RESTORE_TARGET_EXISTS/);
    assertions++;
    check(
      (
        await admin.query("SELECT has_database_privilege('clinic_runtime',$1,'CONNECT') AS yes", [
          state.restoreName,
        ])
      ).rows[0].yes === false,
    );
  } finally {
    await restored.end();
  }
  check(await anonymize(state.manualId));
  process.env.DATABASE_CUTOVER_APPROVAL = 'I_APPROVE_DATABASE_CUTOVER';
  await finalizeRestore(state.restoreName);
  check(
    (await admin.query('SELECT datallowconn FROM pg_database WHERE datname=$1', [state.name]))
      .rows[0].datallowconn === false,
  );
  const finalUrl = new URL(await readFile('/run/secrets/bootstrap_url', 'utf8'));
  finalUrl.pathname = '/' + state.restoreName;
  const finalPg = await import('pg'),
    finalDb = new finalPg.default.Pool({ connectionString: finalUrl.toString(), max: 1 });
  try {
    check(
      (
        await finalDb.query(
          'SELECT count(*)::int AS n FROM appointments WHERE patient_name_ciphertext IS NOT NULL',
        )
      ).rows[0].n === 1,
    );
    check((await finalDb.query('SELECT count(*)::int AS n FROM staff_sessions')).rows[0].n === 0);
  } finally {
    await finalDb.end();
  }
  const sourceIdentity = (
    await admin.query('SELECT datname AS name,oid::text FROM pg_database WHERE datname=$1', [
      state.name,
    ])
  ).rows[0];
  const targetIdentity = (
    await admin.query('SELECT datname AS name,oid::text FROM pg_database WHERE datname=$1', [
      state.restoreName,
    ])
  ).rows[0];
  const cursorPath = (identity) =>
    join(
      process.env.DELETION_LEDGER_DIR,
      'applied-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex') + '.json',
    );
  await copyFile(cursorPath(sourceIdentity), cursorPath(targetIdentity));
  const currentUrlFile = process.env.DATABASE_URL_FILE,
    targetMaintenance = new URL((await readFile(currentUrlFile, 'utf8')).trim());
  targetMaintenance.pathname = '/' + state.restoreName;
  await writeFile(join(root, 'target-maintenance-url'), targetMaintenance.toString());
  process.env.DATABASE_URL_FILE = join(root, 'target-maintenance-url');
  const { reconcilePrivacy } = await import('../ops/reconcile-privacy.mjs');
  await assert.rejects(reconcilePrivacy(), /INVALID_PRIVACY_CURSOR/);
  assertions++;
  await rm(cursorPath(targetIdentity));
  check((await reconcilePrivacy()).applied === 0);
  process.env.DATABASE_URL_FILE = currentUrlFile;
  // Authenticated ciphertext with wrong backup key must never create a database.
  const originalKeyFile = process.env.BACKUP_KEY_FILE,
    originalRingFile = process.env.BACKUP_KEYS_JSON_FILE;
  await writeFile(join(root, 'wrong-key'), randomBytes(32).toString('hex'));
  process.env.BACKUP_KEY_FILE = join(root, 'wrong-key');
  await writeFile(
    join(root, 'wrong-ring'),
    JSON.stringify({ v1: randomBytes(32).toString('hex') }),
  );
  process.env.BACKUP_KEYS_JSON_FILE = join(root, 'wrong-ring');
  await assert.rejects(
    restore(file, 'clinic_test_' + randomBytes(16).toString('hex')),
    /ARCHIVE_CHECKSUM_FAILED/,
  );
  assertions++;
  process.env.BACKUP_KEY_FILE = originalKeyFile;
  process.env.BACKUP_KEYS_JSON_FILE = originalRingFile;
  await copyFile(join(root, 'ledger/registry.json'), join(root, 'registry-verified.json'));
  state.restoreAssertions = assertions;
  state.completedAt = new Date().toISOString();
  await writeFile(join(root, 'state.json'), JSON.stringify(state));
  log('ops_restore_drill_passed', {
    assertions,
    restoreFromBeforeErasure: true,
    syntheticOnly: true,
  });
} finally {
  await db.end();
  for (const target of targets) {
    assert.match(target, /^clinic_test_[a-f0-9]{32}$/);
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [target],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(target)}`);
  }
  await admin.end();
  log('owned_ops_databases_removed');
}
