import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiErrorSchema, healthResponseSchema } from '@clinic/contracts';
import { createApp } from '../src/app.js';

describe('foundation HTTP boundary', () => {
  it('bounds expensive public renders and leaves readiness available', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const app = createApp({
      database: { ping: async () => {} },
      site: {
        render: async () => {
          entered++;
          await gate;
          return { status: 200, html: '<p>Synthetic public page</p>' };
        },
      },
    });
    const isolated = app.listen(0, '127.0.0.1');
    await once(isolated, 'listening');
    const address = isolated.address();
    if (!address || typeof address === 'string') throw new Error('Test address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const requests = Array.from({ length: 4 }, () => fetch(origin + '/ru'));
    try {
      for (let i = 0; i < 100 && entered < 4; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(entered).toBe(4);
      expect((await fetch(origin + '/ru')).status).toBe(503);
      expect((await fetch(origin + '/api/v1/health/ready')).status).toBe(200);
      release();
      expect((await Promise.all(requests)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    } finally {
      release();
      await Promise.allSettled(requests);
      isolated.closeAllConnections();
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
    }
  });
  it('does not accept broad trusted-proxy networks', () => {
    expect(() =>
      createApp({ database: { ping: async () => {} }, trustedProxies: ['0.0.0.0/0'] }),
    ).toThrow('Invalid trusted proxies');
    expect(() =>
      createApp({ database: { ping: async () => {} }, trustedProxies: ['::/0'] }),
    ).toThrow('Invalid trusted proxies');
  });
  const database = { ping: vi.fn<() => Promise<void>>() };
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApp({ database }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    database.ping.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it('liveness works independently of database availability', async () => {
    database.ping.mockImplementation(async () => {
      throw new Error('database is down');
    });
    const response = await fetch(`${baseUrl}/api/v1/health/live`);
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(body).status).toBe('ok');
    expect(database.ping).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('readiness queries the database before reporting ready', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(body).status).toBe('ready');
    expect(database.ping).toHaveBeenCalledOnce();
  });

  it('database failure returns a safe 503 without connection information', async () => {
    database.ping.mockImplementation(async () => {
      throw new Error('postgresql://private:secret@db/patient_data');
    });
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(body).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(text).not.toMatch(/private|secret|postgresql|patient_data|stack/);
  });

  it('creates its own request ID and returns a contract-shaped 404', async () => {
    const response = await fetch(`${baseUrl}/api/v1/not-implemented`, {
      headers: { 'x-request-id': 'untrusted-value' },
    });
    const body: unknown = await response.json();
    const parsed = apiErrorSchema.parse(body);
    expect(response.status).toBe(404);
    expect(parsed.error.code).toBe('NOT_FOUND');
    expect(parsed.error.requestId).toBe(response.headers.get('x-request-id'));
    expect(parsed.error.requestId).not.toBe('untrusted-value');
  });

  it('rejects malformed JSON without returning submitted contents', async () => {
    const response = await fetch(`${baseUrl}/api/v1/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"synthetic_invalid_input"',
    });
    const text = await response.text();
    const body: unknown = JSON.parse(text);
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(body).error.code).toBe('INVALID_JSON');
    expect(text).not.toContain('synthetic_invalid_input');
  });

  it('enforces the JSON size limit', async () => {
    const response = await fetch(`${baseUrl}/api/v1/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ test: 'x'.repeat(17_000) }),
    });
    const body: unknown = await response.json();
    expect(response.status).toBe(413);
    expect(apiErrorSchema.parse(body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not pretend to accept bookings at foundation stage', async () => {
    const response = await fetch(`${baseUrl}/api/v1/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });
});
