import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { createApp } from '../src/app.js';
import { createPrisma } from '../src/infrastructure/prisma.js';
import { AuthService } from '../src/modules/security/service.js';
import { parseSecurityEnvironment } from '../src/modules/security/config.js';
import { seedSyntheticClinic, syntheticIds } from '../src/testing/synthetic-clinic.js';
import { BookingHttpService } from '../src/modules/booking/http-service.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  !/^\/clinic_test_[a-f0-9]{32}$/.test(new URL(url).pathname)
)
  throw new Error('Disposable DB runner required');
const db = createPrisma(url);
const db2 = createPrisma(url);
const origin = 'https://clinic.example.test';
const config = parseSecurityEnvironment({
  NODE_ENV: 'test',
  AUTH_ORIGIN: origin,
  AUTH_MFA_KEY: randomBytes(32).toString('hex'),
  AUTH_CSRF_KEY: randomBytes(32).toString('hex'),
});
let clock = new Date('2030-01-01T00:00:00Z');
const auth = new AuthService(db, config, () => clock);
const auth2 = new AuthService(db2, config, () => clock);
const booking = new BookingHttpService(
  db,
  {
    activeVersion: 'test-v1',
    keys: { 'test-v1': randomBytes(32) },
    hmacKey: randomBytes(32),
    timeZone: 'Asia/Almaty',
  },
  () => clock,
);
const logs: string[] = [];
let servers: Server[] = [];
let base: string;
let rootId: string;
let receptionistId: string;
let password: string;
let rootSecret: string;
let receptionistSecret: string;
const email = 'admin-stage3@example.invalid';
const receptionEmail = 'reception-stage3@example.invalid';
const record = z.record(z.string(), z.unknown());
async function json(response: Response) {
  return record.parse(await response.json());
}
function code(secret: string) {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({ timestamp: clock.getTime() });
}
function advance(ms = 30000) {
  clock = new Date(clock.getTime() + ms);
}

class Client {
  readonly cookies = new Map<string, string>();
  csrfToken: string | undefined;
  constructor(readonly baseUrl = base) {}
  async send(
    method: string,
    path: string,
    body?: unknown,
    options: { csrf?: boolean; origin?: string | null; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.origin !== null) headers.origin = options.origin ?? origin;
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (options.csrf !== false && this.csrfToken && method !== 'GET')
      headers['x-csrf-token'] = this.csrfToken;
    const response = await fetch(this.baseUrl + '/api/v1' + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    }
    return response;
  }
  async csrf() {
    const response = await this.send('GET', '/auth/csrf');
    expect(response.status).toBe(200);
    this.csrfToken = z.object({ csrfToken: z.string() }).parse(await response.json()).csrfToken;
  }
  session() {
    return this.cookies.get(config.sessionCookie) ?? '';
  }
}
async function challenge(client: Client, loginEmail = email, loginPassword = password) {
  await client.csrf();
  const response = await client.send('POST', '/auth/login', {
    email: loginEmail,
    password: loginPassword,
  });
  expect(response.status).toBe(200);
  await client.csrf();
  return response;
}
async function logged(role: 'ADMIN' | 'RECEPTIONIST' = 'ADMIN', baseUrl = base) {
  advance();
  const client = new Client(baseUrl);
  await challenge(client, role === 'ADMIN' ? email : receptionEmail);
  const response = await client.send('POST', '/auth/mfa/verify', {
    code: code(role === 'ADMIN' ? rootSecret : receptionistSecret),
  });
  expect(response.status).toBe(200);
  await client.csrf();
  return client;
}
beforeAll(async () => {
  await Promise.all([auth.ready(), auth2.ready()]);
  const start = async (security: AuthService) => {
    const server = createApp({
      database: { ping: () => db.$queryRaw`SELECT 1`.then(() => {}) },
      security,
      booking,
      reportUnexpected: (requestId) =>
        logs.push(JSON.stringify({ event: 'unexpected_request_error', requestId })),
    }).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    return `http://127.0.0.1:${address.port}`;
  };
  base = await start(auth);
  await start(auth2);
});
beforeEach(async () => {
  clock = new Date('2030-01-01T00:00:00Z');
  logs.length = 0;
  await db.$executeRaw`TRUNCATE TABLE patient_consent_receipts,bootstrap_state,rate_limit_buckets,audit_events,idempotency_keys,appointment_consents,appointments,availability_windows,doctor_services,doctors,services,staff_sessions,staff_users,consent_documents`;
  await seedSyntheticClinic(db, new Date('2030-01-02T00:00:00Z'), clock);
  password = `SYNTHETIC-${randomBytes(24).toString('base64url')}`;
  rootSecret = new OTPAuth.Secret({ size: 20 }).base32;
  receptionistSecret = new OTPAuth.Secret({ size: 20 }).base32;
  rootId = (
    await auth.bootstrap({ email, password, mfaSecret: rootSecret, code: code(rootSecret) })
  ).id;
  receptionistId = (
    await db.staffUser.create({
      data: {
        email: receptionEmail,
        passwordHash: 'DISABLED',
        role: 'RECEPTIONIST',
        isActive: false,
      },
    })
  ).id;
  await auth.provisionCredentials({
    email: receptionEmail,
    password,
    mfaSecret: receptionistSecret,
    code: code(receptionistSecret),
  });
});
afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  servers = [];
  await Promise.all([db.$disconnect(), db2.$disconnect()]);
});

const selection = () => ({
  doctorId: syntheticIds.doctors[0],
  serviceId: syntheticIds.services[0],
  startsAt: '2030-01-02T04:00:00Z',
  expectedPriceKzt: '9000.00',
  expectedDurationMinutes: 30,
});
const payload = () => ({
  ...selection(),
  contacts: { name: 'Синтетический посетитель', phone: '+7 (000) 000-00-00' },
  consent: { documentId: syntheticIds.consent, locale: 'ru', accepted: true },
});
async function createBooking(
  browser: Client,
  key = randomBytes(16).toString('hex'),
  data: unknown = payload(),
) {
  await browser.csrf();
  return browser.send('POST', '/appointments', data, { headers: { 'idempotency-key': key } });
}
async function patientCode(browser = new Client()) {
  await browser.csrf();
  const { contacts, consent } = payload();
  const response = await browser.send('POST', '/patient-consent-codes', { contacts, consent });
  expect(response.status).toBe(201);
  return z
    .object({ code: z.string(), expiresAt: z.string(), documentVersion: z.string() })
    .parse(await response.json());
}
function staffCreate(
  browser: Client,
  consentCode: string,
  key = randomBytes(16).toString('hex'),
  extra: Record<string, unknown> = {},
) {
  return browser.send(
    'POST',
    '/admin/appointments',
    { ...selection(), consentCode, ...extra },
    { headers: { 'idempotency-key': key } },
  );
}
describe('self-service consent and additional staff booking', () => {
  it('binds independent consent and encrypted contacts to staff creation', async () => {
    const receipt = await patientCode(),
      acceptedAt = clock;
    expect(Date.parse(receipt.expiresAt) - acceptedAt.getTime()).toBe(5 * 60000);
    const staff = await logged('RECEPTIONIST'),
      result = await staffCreate(staff, receipt.code);
    expect(result.status).toBe(201);
    expect(result.headers.get('cache-control')).toContain('no-store');
    const body = await result.text();
    expect(body.includes(receipt.code)).toBe(false);
    expect(body.includes(payload().contacts.name)).toBe(false);
    const row = await db.appointment.findFirstOrThrow({
      include: { consent: true, patientConsentReceipt: true },
    });
    expect(row.consent?.acceptedAt.toISOString()).toBe(acceptedAt.toISOString());
    expect(row.consent?.documentId).toBe(syntheticIds.consent);
    expect(row.patientConsentReceipt?.consumedAt).not.toBeNull();
    const stored = await db.patientConsentReceipt.findFirstOrThrow();
    expect(JSON.stringify(stored).includes(receipt.code)).toBe(false);
    expect(JSON.stringify(stored).includes(payload().contacts.name)).toBe(false);
    expect(
      (await db.auditEvent.findFirstOrThrow({ where: { action: 'STAFF_APPOINTMENT_CREATED' } }))
        .actorUserId,
    ).toBe(receptionistId);
    expect(logs.join('').includes(receipt.code)).toBe(false);
  });
  it('rejects missing consent, staff attestation, contact overrides, anonymous create and CSRF', async () => {
    const patient = new Client();
    await patient.csrf();
    const { contacts, consent } = payload();
    expect(
      (
        await patient.send('POST', '/patient-consent-codes', {
          contacts,
          consent: { ...consent, accepted: false },
        })
      ).status,
    ).toBe(400);
    expect(
      (await patient.send('POST', '/patient-consent-codes', { contacts, consent }, { csrf: false }))
        .status,
    ).toBe(403);
    const staff = await logged();
    expect((await staff.send('POST', '/patient-consent-codes', { contacts, consent })).status).toBe(
      403,
    );
    const receipt = await patientCode();
    expect((await staffCreate(patient, receipt.code)).status).toBe(401);
    expect((await staffCreate(staff, receipt.code, undefined, { contacts })).status).toBe(400);
    expect((await staffCreate(staff, receipt.code, undefined, { consent })).status).toBe(400);
    expect(
      (
        await staff.send(
          'POST',
          '/admin/appointments',
          { ...selection(), consentCode: receipt.code },
          { csrf: false },
        )
      ).status,
    ).toBe(403);
    expect(await db.appointment.count()).toBe(0);
  });
  it('expires at exactly five minutes and rejects unknown code without records', async () => {
    const staff = await logged(),
      receipt = await patientCode();
    advance(5 * 60000);
    expect((await staffCreate(staff, receipt.code)).status).toBe(409);
    expect((await staffCreate(staff, '0'.repeat(32))).status).toBe(409);
    expect(await db.appointment.count()).toBe(0);
    expect(await db.appointmentConsent.count()).toBe(0);
    expect(await db.idempotencyKey.count()).toBe(0);
  });
  it('rejects a retired document for issuing and consuming a code', async () => {
    const staff = await logged(),
      receipt = await patientCode();
    await booking.publish({
      version: 'synthetic-next',
      textRu: 'Тестовая новая версия согласия только для синтетических данных.',
      textKk: 'Синтетикалық деректерге арналған келісімнің жаңа сынақ нұсқасы.',
    });
    expect((await staffCreate(staff, receipt.code)).status).toBe(409);
    const patient = new Client();
    await patient.csrf();
    const { contacts, consent } = payload();
    expect(
      (await patient.send('POST', '/patient-consent-codes', { contacts, consent })).status,
    ).toBe(409);
    expect(await db.appointment.count()).toBe(0);
  });
  it('uses a code once but permits identical transport retry of an already committed booking', async () => {
    const staff = await logged(),
      receipt = await patientCode(),
      key = randomBytes(16).toString('hex');
    const first = await staffCreate(staff, receipt.code, key);
    expect(first.status).toBe(201);
    const result = await json(first);
    advance(6 * 60000);
    const retry = await staffCreate(staff, receipt.code, key);
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual(result);
    expect((await staffCreate(staff, receipt.code)).status).toBe(409);
    expect(await db.appointment.count()).toBe(1);
    expect(await db.appointmentConsent.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'STAFF_APPOINTMENT_CREATED' } })).toBe(1);
  });
  it('rolls back receipt consumption on conflict, allowing selection of another free slot', async () => {
    expect((await createBooking(new Client())).status).toBe(201);
    const staff = await logged(),
      receipt = await patientCode();
    expect((await staffCreate(staff, receipt.code)).status).toBe(409);
    expect((await db.patientConsentReceipt.findFirstOrThrow()).consumedAt).toBeNull();
    expect(
      (await staffCreate(staff, receipt.code, undefined, { startsAt: '2030-01-02T04:30:00Z' }))
        .status,
    ).toBe(201);
    expect(await db.appointment.count()).toBe(2);
  });
  it('coordinates twenty staff claims and a simultaneous online booking through one core', async () => {
    const staff = await logged(),
      receipt = await patientCode(),
      patient = new Client();
    await patient.csrf();
    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => staffCreate(staff, receipt.code)),
      patient.send('POST', '/appointments', payload(), {
        headers: { 'idempotency-key': randomBytes(16).toString('hex') },
      }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(20);
    expect(await db.appointment.count()).toBe(1);
    expect(await db.appointmentConsent.count()).toBe(1);
  });
  it('enforces evidence immutability, FK and exact lifetime directly in PostgreSQL', async () => {
    await patientCode();
    const receipt = await db.patientConsentReceipt.findFirstOrThrow();
    await expect(
      db.patientConsentReceipt.update({
        where: { codeHash: receipt.codeHash },
        data: { expiresAt: new Date(clock.getTime() + 600000) },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.patientConsentReceipt.create({
        data: {
          ...receipt,
          codeHash: 'f'.repeat(64),
          expiresAt: new Date(clock.getTime() + 600000),
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.patientConsentReceipt.create({
        data: { ...receipt, codeHash: 'e'.repeat(64), documentId: randomUUID() },
      }),
    ).rejects.toBeDefined();
    const constraints = await db.$queryRaw<
      { conname: string }[]
    >`SELECT conname FROM pg_constraint WHERE conrelid='patient_consent_receipts'::regclass`;
    expect(constraints.some((c) => c.conname === 'patient_consent_receipt_lifetime')).toBe(true);
    expect(constraints.some((c) => c.conname === 'patient_consent_receipt_consumption')).toBe(true);
  });
});

describe('stage 4 HTTP booking and protected workflows', () => {
  it('staff retains readable catalogue labels after entities are archived', async () => {
    await createBooking(new Client());
    const row = await db.appointment.findFirstOrThrow();
    await db.doctor.update({ where: { id: row.doctorId }, data: { isActive: false } });
    await db.service.update({ where: { id: row.serviceId }, data: { isActive: false } });
    const reception = await logged('RECEPTIONIST');
    const detail = await json(await reception.send('GET', `/admin/appointments/${row.id}`));
    expect(detail.doctorNameRu).toBeTruthy();
    expect(detail.serviceNameRu).toBeTruthy();
    const response = await reception.send(
      'GET',
      '/admin/appointments?from=2030-01-01T00:00:00Z&to=2030-01-03T00:00:00Z',
    );
    const data = z
      .object({ items: z.array(z.object({ doctorNameRu: z.string(), serviceNameRu: z.string() })) })
      .parse(await response.json());
    expect(data.items).toHaveLength(1);
  });
  it('creates, lists, rejects overlaps and deletes working windows through staff API', async () => {
    const staff = await logged('RECEPTIONIST'),
      data = {
        doctorId: syntheticIds.doctors[0],
        startsAt: '2030-01-03T04:00:00Z',
        endsAt: '2030-01-03T07:00:00Z',
      };
    const response = await staff.send('POST', '/admin/availability-windows', data);
    expect(response.status).toBe(201);
    const row = await json(response),
      id = z.uuid().parse(row.id);
    expect((await staff.send('POST', '/admin/availability-windows', data)).status).toBe(409);
    const list = await staff.send(
      'GET',
      '/admin/availability-windows?from=2030-01-03T00:00:00Z&to=2030-01-04T00:00:00Z',
    );
    expect(await list.text()).toContain(id);
    expect((await staff.send('DELETE', `/admin/availability-windows/${id}`, {})).status).toBe(204);
  });
  it('conflicting HTTP reschedule preserves the original appointment', async () => {
    const visitor = new Client();
    await createBooking(visitor);
    await createBooking(visitor, randomBytes(16).toString('hex'), {
      ...payload(),
      startsAt: '2030-01-02T05:00:00Z',
    });
    const row = await db.appointment.findFirstOrThrow({ orderBy: { startsAt: 'asc' } }),
      staff = await logged('RECEPTIONIST');
    expect(
      (
        await staff.send('PATCH', `/admin/appointments/${row.id}`, {
          action: 'reschedule',
          version: 1,
          ...selection(),
          startsAt: '2030-01-02T05:00:00Z',
        })
      ).status,
    ).toBe(409);
    expect((await db.appointment.findUniqueOrThrow({ where: { id: row.id } })).startsAt).toEqual(
      row.startsAt,
    );
  });
  it('audit failure rolls back protected booking mutations and redacts errors', async () => {
    await createBooking(new Client());
    const row = await db.appointment.findFirstOrThrow(),
      staff = await logged('RECEPTIONIST');
    await db.$executeRaw`CREATE FUNCTION test_booking_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_ERROR'; END $$`;
    await db.$executeRaw`CREATE TRIGGER test_booking_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_booking_audit_failure()`;
    try {
      const response = await staff.send('PATCH', `/admin/appointments/${row.id}`, {
        action: 'status',
        version: 1,
        status: 'CONFIRMED',
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toMatch(/SYNTHETIC_PRIVATE|stack|sql/);
      expect((await db.appointment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        'PENDING',
      );
      expect(logs.join('')).not.toContain('SYNTHETIC_PRIVATE_ERROR');
    } finally {
      await db.$executeRaw`DROP TRIGGER test_booking_audit_failure ON audit_events`;
      await db.$executeRaw`DROP FUNCTION test_booking_audit_failure()`;
    }
  });
  it('creates sealed contacts and a minimal response; staff detail is audited and queue omits contacts', async () => {
    const publicClient = new Client(),
      response = await createBooking(publicClient);
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(Object.keys(body).sort()).toEqual(
      [
        'reference',
        'status',
        'doctorId',
        'serviceId',
        'startsAt',
        'endsAt',
        'priceKzt',
        'durationMinutes',
      ].sort(),
    );
    const row = await db.appointment.findFirstOrThrow();
    expect(Buffer.from(row.patientNameCiphertext ?? []).toString()).not.toContain(
      payload().contacts.name,
    );
    const reception = await logged('RECEPTIONIST');
    const detail = await json(await reception.send('GET', `/admin/appointments/${row.id}`));
    expect(detail.contacts).toEqual({ name: payload().contacts.name, phone: '+70000000000' });
    const list = await reception.send(
      'GET',
      '/admin/appointments?from=2030-01-01T00:00:00Z&to=2030-01-03T00:00:00Z',
    );
    expect(await list.text()).not.toContain('contacts');
    expect(
      await db.auditEvent.count({
        where: { action: 'APPOINTMENT_CONTACTS_READ', actorUserId: receptionistId },
      }),
    ).toBe(1);
    expect((await publicClient.send('GET', `/admin/appointments/${row.id}`)).status).toBe(401);
    expect(logs).toEqual([]);
  });
  it('20 simultaneous HTTP bookings produce one success and 19 safe conflicts', async () => {
    const browser = new Client();
    await browser.csrf();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        browser.send('POST', '/appointments', payload(), {
          headers: { 'idempotency-key': randomBytes(16).toString('hex') },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(await json(r)).toMatchObject({ error: { code: 'SLOT_UNAVAILABLE' } });
    }
    expect(await db.appointment.count()).toBe(1);
  });
  it('20 retries share one appointment; changed payload gives conflict without leaking the original', async () => {
    const browser = new Client();
    await browser.csrf();
    const key = randomBytes(16).toString('hex');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        browser.send('POST', '/appointments', payload(), { headers: { 'idempotency-key': key } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(19);
    expect(await db.appointmentConsent.count()).toBe(1);
    await db.rateLimitBucket.deleteMany();
    const response = await createBooking(browser, key, {
      ...payload(),
      contacts: { name: 'Другой посетитель', phone: '+70000000000' },
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(payload().contacts.name);
  });
  it('rejects CSRF, missing key, PII extensions, past times, changed offers and consent', async () => {
    const browser = new Client();
    expect((await browser.send('POST', '/appointments', payload())).status).toBe(403);
    await browser.csrf();
    expect((await browser.send('POST', '/appointments', payload())).status).toBe(400);
    for (const data of [
      { ...payload(), iin: '000000000000' },
      { ...payload(), diagnosis: 'forbidden' },
      { ...payload(), contacts: { ...payload().contacts, notes: 'forbidden' } },
      { ...payload(), expectedPriceKzt: '1.00' },
      { ...payload(), consent: { ...payload().consent, documentId: randomUUID() } },
      { ...payload(), startsAt: '2029-01-01T04:00:00Z' },
    ])
      expect([400, 409]).toContain(
        (await createBooking(browser, randomBytes(16).toString('hex'), data)).status,
      );
    expect(await db.appointment.count()).toBe(0);
    expect(logs).toEqual([]);
  });
  it('availability is a clinic-zone day without busy identities and respects breaks and limits', async () => {
    const browser = new Client();
    const path = `/availability?doctorId=${syntheticIds.doctors[0]}&serviceId=${syntheticIds.services[0]}&date=2030-01-02`;
    const result = await json(await browser.send('GET', path));
    expect(result.timeZone).toBe('Asia/Almaty');
    expect(JSON.stringify(result)).not.toMatch(/contacts|reference|patient/);
    expect((await browser.send('GET', path + '&phone=private')).status).toBe(400);
    expect((await browser.send('GET', path.replace('2030-01-02', '2020-01-01'))).status).toBe(400);
  });
  it('receptionist manages windows and cannot shorten occupied work or bypass version', async () => {
    await createBooking(new Client());
    const row = await db.appointment.findFirstOrThrow(),
      reception = await logged('RECEPTIONIST');
    expect(
      (
        await reception.send('PATCH', `/admin/availability-windows/${syntheticIds.windows[0]}`, {
          doctorId: row.doctorId,
          startsAt: '2030-01-02T05:00:00Z',
          endsAt: '2030-01-02T07:00:00Z',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await reception.send('PATCH', `/admin/appointments/${row.id}`, {
          action: 'status',
          version: 1,
          status: 'CONFIRMED',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await reception.send('PATCH', `/admin/appointments/${row.id}`, {
          action: 'status',
          version: 1,
          status: 'CANCELLED',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await reception.send('PATCH', `/admin/appointments/${row.id}`, {
          action: 'reschedule',
          version: 2,
          ...selection(),
          startsAt: '2030-01-02T05:00:00Z',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await reception.send('PATCH', `/admin/appointments/${row.id}`, {
          action: 'status',
          version: 3,
          status: 'CANCELLED',
        })
      ).status,
    ).toBe(200);
    expect((await createBooking(new Client())).status).toBe(201);
    expect(
      await db.auditEvent.count({
        where: { action: 'APPOINTMENT_RESCHEDULED', actorUserId: receptionistId },
      }),
    ).toBe(1);
  });
  it('ADMIN records verified consent withdrawal once without silently deleting or cancelling', async () => {
    await createBooking(new Client());
    const row = await db.appointment.findFirstOrThrow(),
      reception = await logged('RECEPTIONIST');
    expect(
      (
        await reception.send('POST', `/admin/appointments/${row.id}/consent-withdrawal`, {
          version: 1,
          confirmedIdentity: true,
        })
      ).status,
    ).toBe(403);
    const root = await logged();
    expect(
      (
        await root.send('POST', `/admin/appointments/${row.id}/consent-withdrawal`, {
          version: 1,
          confirmedIdentity: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await root.send('POST', `/admin/appointments/${row.id}/consent-withdrawal`, {
          version: 1,
          confirmedIdentity: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await root.send('POST', `/admin/appointments/${row.id}/consent-withdrawal`, {
          version: 1,
          confirmedIdentity: true,
        })
      ).status,
    ).toBe(409);
    expect((await db.appointment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'PENDING',
    );
    expect(rootId).toBeTruthy();
  });
  it('publishes immutable bilingual consent and rejects stale consent after publication', async () => {
    const browser = new Client();
    const current = await json(await browser.send('GET', '/consent-documents/current?locale=kk'));
    expect(current.id).toBe(syntheticIds.consent);
    await booking.publish({
      version: 'synthetic-v2',
      textRu: 'Синтетический новый текст согласия',
      textKk: 'Синтетикалық келісімнің жаңа мәтіні',
    });
    expect((await createBooking(browser)).status).toBe(409);
    expect(
      (await db.consentDocument.findUniqueOrThrow({ where: { id: syntheticIds.consent } }))
        .retiredAt,
    ).not.toBeNull();
  });
});
