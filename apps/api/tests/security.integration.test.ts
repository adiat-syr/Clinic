import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { createApp } from '../src/app.js';
import { createPrisma } from '../src/infrastructure/prisma.js';
import { AuthService } from '../src/modules/security/service.js';
import { parseSecurityEnvironment } from '../src/modules/security/config.js';
import { hashToken, verifyPassword } from '../src/modules/security/crypto.js';
import {
  seedSyntheticClinic,
  syntheticIds,
  syntheticContacts,
} from '../src/testing/synthetic-clinic.js';
import { BookingService } from '../src/modules/booking/service.js';

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
const logs: string[] = [];
let servers: Server[] = [];
let base: string;
let secondBase: string;
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
const doctorBody = {
  slug: 'synthetic-new-doctor',
  nameRu: 'Синтетический новый врач',
  nameKk: 'Синтетикалық дәрігер',
  specialtyRu: 'Тест',
  specialtyKk: 'Тест',
  bioRu: 'Тестовые данные',
  bioKk: 'Тест',
  photoAssetKey: null,
};
const serviceBody = {
  slug: 'synthetic-new-service',
  nameRu: 'Синтетическая услуга',
  nameKk: 'Синтетикалық қызмет',
  descriptionRu: 'Тест',
  descriptionKk: 'Тест',
  durationMinutes: 35,
  priceKzt: '12345.67',
};

beforeAll(async () => {
  await Promise.all([auth.ready(), auth2.ready()]);
  const start = async (security: AuthService) => {
    const server = createApp({
      database: { ping: () => db.$queryRaw`SELECT 1`.then(() => {}) },
      security,
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
  secondBase = await start(auth2);
});
beforeEach(async () => {
  clock = new Date('2030-01-01T00:00:00Z');
  logs.length = 0;
  await db.$executeRaw`TRUNCATE TABLE bootstrap_state,rate_limit_buckets,audit_events,idempotency_keys,appointment_consents,appointments,availability_windows,doctor_services,doctors,services,staff_sessions,staff_users,consent_documents`;
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

describe('bootstrap and credential boundaries', () => {
  it('bootstrap is one-time even after blocking', async () => {
    await expect(
      auth.bootstrap({
        email: 'another@example.invalid',
        password,
        mfaSecret: rootSecret,
        code: code(rootSecret),
      }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });
    await db.staffUser.update({ where: { id: rootId }, data: { isActive: false } });
    await expect(
      auth.bootstrap({
        email: 'another@example.invalid',
        password,
        mfaSecret: rootSecret,
        code: code(rootSecret),
      }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });
    await expect(db.$executeRaw`DELETE FROM bootstrap_state`).rejects.toBeDefined();
  });
  it('serializes concurrent bootstrap attempts across independent processes', async () => {
    await db.$executeRaw`TRUNCATE TABLE bootstrap_state,audit_events,staff_sessions,staff_users`;
    const results = await Promise.allSettled([
      auth.bootstrap({ email, password, mfaSecret: rootSecret, code: code(rootSecret) }),
      auth2.bootstrap({
        email: 'other-bootstrap@example.invalid',
        password,
        mfaSecret: receptionistSecret,
        code: code(receptionistSecret),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'BOOTSTRAP_ALREADY_COMPLETED' },
    });
    expect(await db.bootstrapState.count()).toBe(1);
    expect(await db.staffUser.count({ where: { role: 'ADMIN', isActive: true } })).toBe(1);
  });
  it('stores Argon2id and encrypted MFA, never raw password or MFA text', async () => {
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: rootId } });
    expect(row.passwordHash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    expect(await verifyPassword(row.passwordHash, password)).toBe(true);
    expect(row.passwordHash).not.toBe(password);
    expect(Buffer.from(row.mfaSecretCiphertext ?? []).includes(Buffer.from(rootSecret))).toBe(
      false,
    );
  });
  it('CLI rejects piped credentials and does not echo the input', async () => {
    const sentinel = `SYNTHETIC-DO-NOT-ECHO-${randomUUID()}`;
    const result = await new Promise<{ status: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('../scripts/staff.ts', import.meta.url)),
            'bootstrap',
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, output }));
        child.stdin.on('error', () => {});
        child.stdin.end(sentinel);
      },
    );
    expect(result.status).toBe(1);
    expect(result.output).not.toContain(sentinel);
    expect(result.output).toContain('interactive private terminal');
  });
});

describe('real HTTP authentication, MFA, sessions and CSRF', () => {
  it('session status checks do not keep an idle session alive', async () => {
    const browser = await logged();
    const before = await db.staffSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(browser.session()) },
    });
    advance(29 * 60000);
    expect((await browser.send('GET', '/auth/me')).status).toBe(200);
    expect(
      (await db.staffSession.findUniqueOrThrow({ where: { id: before.id } })).lastSeenAt,
    ).toEqual(before.lastSeenAt);
    advance(60001);
    expect((await browser.send('GET', '/auth/me')).status).toBe(401);
  });
  it('revoked challenges cannot consume another live challenge account quota', async () => {
    const stale = new Client();
    await challenge(stale);
    await db.staffSession.updateMany({
      where: { tokenHash: hashToken(stale.session()) },
      data: { revokedAt: clock },
    });
    const live = new Client(secondBase);
    await challenge(live);
    advance();
    for (let i = 0; i < 5; i++)
      expect((await stale.send('POST', '/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    expect((await live.send('POST', '/auth/mfa/verify', { code: code(rootSecret) })).status).toBe(
      200,
    );
  });
  it('password creates only a challenge; MFA rotates the token and unlocks me', async () => {
    const browser = new Client();
    const passwordResponse = await challenge(browser);
    const old = browser.session();
    expect(passwordResponse.headers.getSetCookie().join(';')).toMatch(/Max-Age=300/);
    expect((await browser.send('GET', '/auth/me')).status).toBe(401);
    const cookieOnly = await db.staffSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(old) },
    });
    expect(cookieOnly.authStage).toBe('CHALLENGE');
    expect(cookieOnly.tokenHash).not.toBe(old);
    advance();
    const response = await browser.send('POST', '/auth/mfa/verify', { code: code(rootSecret) });
    expect(response.status).toBe(200);
    expect(browser.session()).not.toBe(old);
    const cookies = response.headers.getSetCookie().join(';');
    for (const flag of [
      '__Host-clinic_session',
      'Secure',
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=28800',
    ])
      expect(cookies).toContain(flag);
    expect(cookies).not.toContain('Domain=');
    expect(await json(await browser.send('GET', '/auth/me'))).toEqual({
      id: rootId,
      email,
      role: 'ADMIN',
    });
    const stolenOld = new Client();
    stolenOld.cookies.set(config.sessionCookie, old);
    expect((await stolenOld.send('GET', '/auth/me')).status).toBe(401);
  });
  it('unknown, disabled and wrong-password attempts return the same safe failure', async () => {
    const browser = new Client();
    await browser.csrf();
    for (const payload of [
      { email, password: 'wrong' },
      { email: 'not-present@example.invalid', password },
      { email: 'synthetic-admin@example.invalid', password },
    ]) {
      const response = await browser.send('POST', '/auth/login', payload);
      expect(response.status).toBe(401);
      expect(
        z
          .object({ error: z.object({ code: z.literal('LOGIN_FAILED') }) })
          .safeParse(await response.json()).success,
      ).toBe(true);
    }
    expect(await db.staffSession.count()).toBe(0);
  });
  it('concurrent verification of one TOTP code permits exactly one session', async () => {
    const first = new Client();
    const second = new Client(secondBase);
    await challenge(first);
    await challenge(second);
    advance();
    const same = code(rootSecret);
    const results = await Promise.all([
      first.send('POST', '/auth/mfa/verify', { code: same }),
      second.send('POST', '/auth/mfa/verify', { code: same }),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([200, 401]);
    expect(await db.staffSession.count({ where: { authStage: 'AUTHENTICATED' } })).toBe(1);
  });
  it('rejects invalid MFA, challenge expiry and replay across a new login', async () => {
    const browser = new Client();
    await challenge(browser);
    expect((await browser.send('POST', '/auth/mfa/verify', { code: 'not-a-code' })).status).toBe(
      400,
    );
    advance();
    const current = code(rootSecret);
    const wrong = current === '000000' ? '111111' : '000000';
    expect((await browser.send('POST', '/auth/mfa/verify', { code: wrong })).status).toBe(401);
    expect((await browser.send('POST', '/auth/mfa/verify', { code: current })).status).toBe(200);
    const other = new Client();
    await challenge(other);
    expect((await other.send('POST', '/auth/mfa/verify', { code: current })).status).toBe(401);
    advance(5 * 60000 + 1);
    await other.csrf();
    expect((await other.send('POST', '/auth/mfa/verify', { code: code(rootSecret) })).status).toBe(
      401,
    );
  });
  it('enforces idle and absolute expiry independently', async () => {
    const browser = await logged();
    advance(30 * 60000);
    expect((await browser.send('GET', '/auth/me')).status).toBe(401);
    const fresh = await logged();
    advance(8 * 60 * 60000 + 1);
    await db.staffSession.updateMany({
      where: { tokenHash: hashToken(fresh.session()) },
      data: { lastSeenAt: clock },
    });
    expect((await fresh.send('GET', '/auth/me')).status).toBe(401);
  });
  it('logout revokes its session and clears the cookie', async () => {
    const browser = await logged();
    const raw = browser.session();
    expect((await browser.send('POST', '/auth/logout', {})).status).toBe(204);
    expect(browser.session()).toBe('');
    expect(
      (await db.staffSession.findUniqueOrThrow({ where: { tokenHash: hashToken(raw) } })).revokedAt,
    ).not.toBeNull();
    const old = new Client();
    old.cookies.set(config.sessionCookie, raw);
    expect((await old.send('GET', '/auth/me')).status).toBe(401);
  });
  it('requires CSRF and exact Origin even for login and logout', async () => {
    const browser = new Client();
    expect((await browser.send('POST', '/auth/login', { email, password })).status).toBe(403);
    await browser.csrf();
    expect(
      (
        await browser.send(
          'POST',
          '/auth/login',
          { email, password },
          { origin: 'https://attacker.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await browser.send('POST', '/auth/login', { email, password }, { origin: null })).status,
    ).toBe(403);
    const authorised = await logged();
    expect((await authorised.send('POST', '/auth/logout', {}, { csrf: false })).status).toBe(403);
    expect(
      (
        await authorised.send('POST', '/admin/services', serviceBody, {
          origin: 'https://attacker.example',
        })
      ).status,
    ).toBe(403);
  });
  it('invalidates old CSRF tokens after session rotation', async () => {
    const browser = new Client();
    await browser.csrf();
    const old = browser.csrfToken;
    expect((await browser.send('POST', '/auth/login', { email, password })).status).toBe(200);
    expect(
      (await browser.send('POST', '/auth/mfa/verify', { code: code(rootSecret) })).status,
    ).toBe(403);
    expect(browser.csrfToken).toBe(old);
  });
  it('limits password attempts across processes', async () => {
    const first = new Client();
    await first.csrf();
    const second = new Client(secondBase);
    await second.csrf();
    for (let i = 0; i < 10; i++) {
      const browser = i % 2 ? first : second;
      expect(
        (
          await browser.send(
            'POST',
            '/auth/login',
            { email, password: 'wrong' },
            { headers: { 'x-forwarded-for': `192.0.2.${i}` } },
          )
        ).status,
      ).toBe(401);
    }
    expect((await second.send('POST', '/auth/login', { email, password })).status).toBe(429);
  });
  it('does not let forwarded headers bypass the shared IP limit', async () => {
    const browser = new Client(secondBase);
    await browser.csrf();
    for (let i = 0; i < 30; i++)
      await auth.limiter.require('login-ip', '127.0.0.1', 30, 15 * 60000);
    const response = await browser.send(
      'POST',
      '/auth/login',
      { email: 'unseen@example.invalid', password },
      { headers: { 'x-forwarded-for': '192.0.2.99', forwarded: 'for=192.0.2.100' } },
    );
    expect(response.status).toBe(429);
    advance(15 * 60000 + 1);
    expect((await browser.send('POST', '/auth/login', { email, password })).status).toBe(200);
  });
  it('enforces a shared rate bucket atomically under concurrent attempts', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? auth : auth2).limiter.require(
          'synthetic-concurrency',
          'synthetic-identity',
          5,
          60000,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    for (const result of results.filter((result) => result.status === 'rejected'))
      expect(result.reason).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    const rows = await db.rateLimitBucket.findMany();
    expect(rows.some((row) => row.keyHash.includes('synthetic-identity'))).toBe(false);
    advance(60001);
    await expect(
      auth2.limiter.require('synthetic-concurrency', 'synthetic-identity', 5, 60000),
    ).resolves.toBeUndefined();
  });
  it('limits MFA attempts without leaking the secret or code', async () => {
    const browser = new Client();
    await challenge(browser);
    advance();
    const wrong = code(rootSecret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect((await browser.send('POST', '/auth/mfa/verify', { code: wrong })).status).toBe(401);
    expect(
      (await browser.send('POST', '/auth/mfa/verify', { code: code(rootSecret) })).status,
    ).toBe(429);
  });
});

describe('roles, strict catalogue DTOs and revocation', () => {
  it('returns 401 without a full session and 403 for RECEPTIONIST admin operations', async () => {
    const anonymous = new Client();
    expect((await anonymous.send('GET', '/admin/doctors')).status).toBe(401);
    const reception = await logged('RECEPTIONIST');
    for (const path of ['/admin/doctors', '/admin/services', '/admin/staff', '/admin/audit-events'])
      expect((await reception.send('GET', path)).status).toBe(403);
    expect((await reception.send('POST', '/admin/doctors', doctorBody)).status).toBe(403);
    expect(
      (await reception.send('PATCH', `/admin/staff/${receptionistId}`, { role: 'ADMIN' })).status,
    ).toBe(403);
    expect((await reception.send('GET', '/services')).status).toBe(200);
  });
  it('rejects role escalation/mass assignment in login, MFA and catalogue payloads', async () => {
    const browser = new Client();
    await browser.csrf();
    expect(
      (await browser.send('POST', '/auth/login', { email, password, role: 'ADMIN' })).status,
    ).toBe(400);
    await challenge(browser);
    expect(
      (
        await browser.send('POST', '/auth/mfa/verify', {
          code: code(rootSecret),
          role: 'ADMIN',
          authStage: 'AUTHENTICATED',
        })
      ).status,
    ).toBe(400);
    const root = await logged();
    for (const data of [
      { ...doctorBody, role: 'ADMIN' },
      { ...doctorBody, passwordHash: 'forbidden' },
      { ...doctorBody, id: randomUUID() },
    ])
      expect((await root.send('POST', '/admin/doctors', data)).status).toBe(400);
    expect(
      (await root.send('PATCH', `/admin/services/${syntheticIds.services[0]}`, { priceKzt: 'NaN' }))
        .status,
    ).toBe(400);
    expect(
      (
        await root.send('PATCH', `/admin/staff/${receptionistId}`, {
          mfaEnabled: true,
          passwordHash: 'forbidden',
        })
      ).status,
    ).toBe(400);
    expect((await root.send('GET', '/services?email=private')).status).toBe(400);
  });
  it('rejects unsafe catalogue values and immutable fields without changing the offer', async () => {
    const root = await logged();
    for (const patch of [
      { durationMinutes: 0 },
      { durationMinutes: 1441 },
      { priceKzt: 1.25 },
      { priceKzt: 'NaN' },
      { priceKzt: '-1.00' },
      { priceKzt: '1e4' },
      { slug: 'another-slug' },
      { createdAt: '2030-01-01T00:00:00Z' },
      {},
    ])
      expect(
        (await root.send('PATCH', `/admin/services/${syntheticIds.services[0]}`, patch)).status,
      ).toBe(400);
    expect(
      await json(await root.send('GET', `/admin/services/${syntheticIds.services[0]}`)),
    ).toMatchObject({ priceKzt: '9000.00', durationMinutes: 30 });
  });
  it('creates/reads/edits doctors and services, assigns a service, and deactivates instead of deleting', async () => {
    const root = await logged();
    const created = await root.send('POST', '/admin/doctors', doctorBody);
    expect(created.status).toBe(201);
    const doctorId = z.object({ id: z.uuid() }).parse(await created.json()).id;
    const service = await root.send('POST', '/admin/services', serviceBody);
    expect(service.status).toBe(201);
    const serviceId = z.object({ id: z.uuid() }).parse(await service.json()).id;
    expect(
      (
        await root.send('PUT', `/admin/doctors/${doctorId}/services/${serviceId}`, {
          isActive: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await root.send('PATCH', `/admin/doctors/${doctorId}`, {
          nameRu: 'Синтетическое обновление',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await root.send('PATCH', `/admin/services/${serviceId}`, {
          priceKzt: '20000.10',
          durationMinutes: 40,
        })
      ).status,
    ).toBe(200);
    expect(await json(await root.send('GET', `/admin/services/${serviceId}`))).toMatchObject({
      priceKzt: '20000.10',
      durationMinutes: 40,
    });
    const publicDoctor = await json(await root.send('GET', `/doctors/${doctorBody.slug}`));
    expect(publicDoctor).toMatchObject({
      nameRu: 'Синтетическое обновление',
      services: [{ priceKzt: '20000.10', durationMinutes: 40 }],
    });
    expect(Object.keys(publicDoctor).sort()).toEqual(
      [
        'id',
        'slug',
        'nameRu',
        'nameKk',
        'specialtyRu',
        'specialtyKk',
        'bioRu',
        'bioKk',
        'photoAssetKey',
        'services',
      ].sort(),
    );
    expect(
      (await root.send('PATCH', `/admin/services/${serviceId}`, { isActive: false })).status,
    ).toBe(200);
    expect((await root.send('GET', `/services/${serviceBody.slug}`)).status).toBe(404);
    expect(await json(await root.send('GET', `/doctors/${doctorBody.slug}`))).toMatchObject({
      services: [],
    });
    expect(
      (await root.send('PATCH', `/admin/doctors/${doctorId}`, { isActive: false })).status,
    ).toBe(200);
    expect((await root.send('GET', `/doctors/${doctorBody.slug}`)).status).toBe(404);
    expect(await db.doctor.count({ where: { id: doctorId } })).toBe(1);
    expect(await db.service.count({ where: { id: serviceId } })).toBe(1);
    expect((await root.send('DELETE', `/admin/doctors/${doctorId}`)).status).toBe(404);
  });
  it('preserves booking snapshots and relationships when catalogue entities are deactivated', async () => {
    const booking = await new BookingService(db, {
      idempotencySecret: randomBytes(32),
      now: () => clock,
    }).create({
      doctorId: syntheticIds.doctors[0],
      serviceId: syntheticIds.services[0],
      startsAt: '2030-01-02T04:00:00Z',
      expectedPriceKzt: '9000.00',
      expectedDurationMinutes: 30,
      idempotencyKey: randomBytes(16).toString('hex'),
      contacts: syntheticContacts(randomBytes(32)),
      consent: { documentId: syntheticIds.consent, accepted: true, locale: 'ru' },
    });
    const root = await logged();
    expect(
      (
        await root.send('PATCH', `/admin/services/${syntheticIds.services[0]}`, {
          priceKzt: '10000.00',
          durationMinutes: 45,
          isActive: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await root.send(
          'PUT',
          `/admin/doctors/${syntheticIds.doctors[0]}/services/${syntheticIds.services[0]}`,
          { isActive: false },
        )
      ).status,
    ).toBe(200);
    expect(
      (await root.send('PATCH', `/admin/doctors/${syntheticIds.doctors[0]}`, { isActive: false }))
        .status,
    ).toBe(200);
    const row = await db.appointment.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.priceKztSnapshot.toFixed(2)).toBe('9000.00');
    expect(row.durationMinutesSnapshot).toBe(30);
    expect((await root.send('GET', `/admin/appointments/${booking.id}`)).status).toBe(404);
  });
  it('audits actor and field names atomically and rolls back when audit insertion fails', async () => {
    const root = await logged();
    const changed = await root.send('PATCH', `/admin/doctors/${syntheticIds.doctors[0]}`, {
      nameRu: 'Синтетическое имя',
    });
    expect(changed.status).toBe(200);
    const event = await db.auditEvent.findFirstOrThrow({ where: { action: 'DOCTOR_UPDATED' } });
    expect(event.actorUserId).toBe(rootId);
    expect(event.metadata).toEqual({ fields: ['nameRu'] });
    await db.$executeRaw`CREATE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SECRET_MUST_NOT_LEAK'; END $$`;
    await db.$executeRaw`CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_fail_audit()`;
    try {
      const response = await root.send('PATCH', `/admin/doctors/${syntheticIds.doctors[0]}`, {
        nameRu: 'MUST_ROLL_BACK',
      });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toMatch(/SYNTHETIC_SECRET|stack|query|sql|MUST_ROLL_BACK/);
      expect(
        (await db.doctor.findUniqueOrThrow({ where: { id: syntheticIds.doctors[0] } })).nameRu,
      ).toBe('Синтетическое имя');
      const output = logs.join('');
      for (const secret of [
        password,
        rootSecret,
        root.session(),
        root.csrfToken ?? 'unused',
        email,
        Buffer.from(config.mfaKey).toString('hex'),
        Buffer.from(config.csrfKey).toString('hex'),
        'SYNTHETIC_SECRET_MUST_NOT_LEAK',
        'MUST_ROLL_BACK',
      ])
        expect(output).not.toContain(secret);
    } finally {
      await db.$executeRaw`DROP TRIGGER test_fail_audit ON audit_events`;
      await db.$executeRaw`DROP FUNCTION test_fail_audit()`;
    }
  });
  it('creates inactive staff, prevents unsafe activation, and refuses removing the last ADMIN', async () => {
    const root = await logged();
    const response = await root.send('POST', '/admin/staff', {
      email: 'new-stage3@example.invalid',
      role: 'RECEPTIONIST',
    });
    expect(response.status).toBe(201);
    const data = await json(response);
    expect(Object.keys(data).sort()).toEqual(
      ['id', 'email', 'role', 'isActive', 'mfaEnabled'].sort(),
    );
    expect(data.isActive).toBe(false);
    const id = z.uuid().parse(data.id);
    expect((await root.send('PATCH', `/admin/staff/${id}`, { isActive: true })).status).toBe(409);
    expect(
      (await root.send('PATCH', `/admin/staff/${rootId}`, { role: 'RECEPTIONIST' })).status,
    ).toBe(409);
    expect((await root.send('PATCH', `/admin/staff/${rootId}`, { isActive: false })).status).toBe(
      409,
    );
  });
  it('limits audit ranges, audits staff/audit reads and suppresses unapproved metadata', async () => {
    const root = await logged();
    const response = await root.send('GET', `/admin/staff/${receptionistId}`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      id: receptionistId,
      email: receptionEmail,
      role: 'RECEPTIONIST',
      isActive: true,
      mfaEnabled: true,
    });
    await db.auditEvent.create({
      data: {
        action: 'SYNTHETIC_UNKNOWN_METADATA',
        entityType: 'test',
        requestId: randomUUID(),
        metadata: { secret: 'SYNTHETIC_DO_NOT_EXPOSE' },
        createdAt: clock,
      },
    });
    const audit = await root.send('GET', '/admin/audit-events');
    expect(audit.status).toBe(200);
    const output = await audit.text();
    expect(output).toContain('SYNTHETIC_UNKNOWN_METADATA');
    expect(output).not.toContain('SYNTHETIC_DO_NOT_EXPOSE');
    expect(
      await db.auditEvent.count({ where: { action: 'STAFF_READ', actorUserId: rootId } }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({ where: { action: 'AUDIT_READ', actorUserId: rootId } }),
    ).toBe(1);
    expect(
      (
        await root.send(
          'GET',
          '/admin/audit-events?from=2029-01-01T00:00:00Z&to=2030-01-01T00:00:00Z',
        )
      ).status,
    ).toBe(400);
  });
  it('preserves one active ADMIN when two administrators concurrently block themselves', async () => {
    const root = await logged();
    expect(
      (await root.send('PATCH', `/admin/staff/${receptionistId}`, { role: 'ADMIN' })).status,
    ).toBe(200);
    const other = await logged('RECEPTIONIST', secondBase);
    const results = await Promise.all([
      root.send('PATCH', `/admin/staff/${rootId}`, { isActive: false }),
      other.send('PATCH', `/admin/staff/${receptionistId}`, { isActive: false }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await db.staffUser.count({ where: { role: 'ADMIN', isActive: true } })).toBe(1);
  });
  it('revokes all sessions on role change, blocking, password change and explicit revocation', async () => {
    const root = await logged();
    const reception = await logged('RECEPTIONIST');
    expect(
      (await root.send('PATCH', `/admin/staff/${receptionistId}`, { role: 'ADMIN' })).status,
    ).toBe(200);
    expect((await reception.send('GET', '/auth/me')).status).toBe(401);
    const newReception = await logged('RECEPTIONIST');
    expect(
      (await root.send('PATCH', `/admin/staff/${receptionistId}`, { isActive: false })).status,
    ).toBe(200);
    expect((await newReception.send('GET', '/auth/me')).status).toBe(401);
    expect((await root.send('POST', `/admin/staff/${rootId}/revoke-sessions`, {})).status).toBe(
      204,
    );
    expect((await root.send('GET', '/auth/me')).status).toBe(401);
  });
  it('own password change invalidates sessions and the old password', async () => {
    const first = await logged();
    const second = await logged();
    const next = `SYNTHETIC-NEXT-${randomBytes(24).toString('hex')}`;
    expect(
      (await first.send('POST', '/auth/password', { currentPassword: password, newPassword: next }))
        .status,
    ).toBe(204);
    expect((await second.send('GET', '/auth/me')).status).toBe(401);
    const old = new Client();
    await old.csrf();
    expect((await old.send('POST', '/auth/login', { email, password })).status).toBe(401);
    const fresh = new Client();
    await challenge(fresh, email, next);
  });
  it('limits guesses of the current password across authenticated sessions', async () => {
    const first = await logged(),
      second = await logged('ADMIN', secondBase);
    for (let index = 0; index < 5; index++)
      expect(
        (
          await (index % 2 ? first : second).send('POST', '/auth/password', {
            currentPassword: 'wrong',
            newPassword: password,
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await first.send('POST', '/auth/password', {
          currentPassword: password,
          newPassword: password,
        })
      ).status,
    ).toBe(429);
  });
  it('offline MFA/credentials recovery revokes sessions without changing role', async () => {
    const root = await logged();
    const replacement = new OTPAuth.Secret({ size: 20 }).base32;
    await auth.provisionCredentials({
      email,
      password,
      mfaSecret: replacement,
      code: code(replacement),
    });
    expect((await root.send('GET', '/auth/me')).status).toBe(401);
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: rootId } })).role).toBe('ADMIN');
  });
  it('public catalogue and generic errors contain no staff, patient or credential fields', async () => {
    const anonymous = new Client();
    const responses = await Promise.all(
      ['/doctors', '/services', '/doctors/missing', '/admin/staff'].map((path) =>
        anonymous.send('GET', path),
      ),
    );
    const text = (await Promise.all(responses.map((response) => response.text()))).join('\n');
    for (const secret of [
      email,
      receptionEmail,
      password,
      rootSecret,
      receptionistSecret,
      'passwordHash',
      'mfaSecretCiphertext',
      'patientNameCiphertext',
      'tokenHash',
      'staff_sessions',
      'stack',
    ])
      expect(text).not.toContain(secret);
    expect(logs).toEqual([]);
  });
});
