import { afterEach, expect, test } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { createPortfolioGateway } from '../src/portfolio/gateway.js';
import { portfolioContacts } from '@clinic/contracts';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port missing');
  return `http://127.0.0.1:${address.port}`;
}
test('portfolio refuses private routes and arbitrary contacts before reaching the API', async () => {
  let forwarded = 0;
  const upstream = express();
  upstream.use((_req, res) => {
    forwarded++;
    res.json({ ok: true });
  });
  const base = await listen(createPortfolioGateway(await listen(upstream), '.tmp/missing-assets'));
  for (const path of [
    '/admin',
    '/admin/users',
    '/api/v1/admin/appointments',
    '/api/v1/auth/me',
    '/api/v1/auth/login',
    '/ru/phone-consent',
    '/kk/phone-consent',
  ]) {
    expect((await fetch(base + path)).status).toBe(404);
  }
  expect(
    (
      await fetch(base + '/api/v1/appointments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contacts: { name: 'Other fictional visitor', phone: '+70000000000' },
        }),
      })
    ).status,
  ).toBe(400);
  expect(forwarded).toBe(0);
});
test('portfolio preserves booking headers, body, status and secure CSRF cookie', async () => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/api/v1/appointments', (req, res) => {
    expect(req.body).toEqual({ contacts: portfolioContacts });
    expect(req.get('idempotency-key')).toBe('synthetic-repeat-key');
    expect(req.get('x-csrf-token')).toBe('synthetic-csrf');
    expect(req.get('origin')).toBe('https://portfolio.example.invalid');
    res.status(201).setHeader('set-cookie', '__Host-clinic_csrf=fixture; Secure; HttpOnly; Path=/');
    res.json({ reference: 'DEMO' });
  });
  const base = await listen(createPortfolioGateway(await listen(upstream), '.tmp/missing-assets'));
  const response = await fetch(base + '/api/v1/appointments', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'synthetic-repeat-key',
      'x-csrf-token': 'synthetic-csrf',
      origin: 'https://portfolio.example.invalid',
    },
    body: JSON.stringify({ contacts: portfolioContacts }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get('set-cookie')).toContain('Secure');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ reference: 'DEMO' });
});
