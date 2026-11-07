import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { portfolioContacts } from '@clinic/contracts';
import { z } from 'zod';

const fixedContacts = z.object({
  contacts: z.strictObject({
    name: z.literal(portfolioContacts.name),
    phone: z.literal(portfolioContacts.phone),
  }),
});
const reads = new Set([
  '/api/v1/health/live',
  '/api/v1/health/ready',
  '/api/v1/clinic',
  '/api/v1/services',
  '/api/v1/doctors',
  '/api/v1/availability',
  '/api/v1/consent-documents/current',
  '/api/v1/auth/csrf',
]);

export function createPortfolioGateway(upstream: string, assets: string) {
  const origin = new URL(upstream);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1')
    throw new Error('Loopback API required');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  const refuse = (res: express.Response, status: number, code: string) =>
    res
      .status(status)
      .json({ error: { code, message: 'Portfolio demo', requestId: randomUUID() } });
  app.use(async (req, res, next) => {
    const read = ['GET', 'HEAD'].includes(req.method);
    const publicPage = /^\/(?:$|(?:ru|kk)(?:\/(?!phone-consent(?:\/|$)).*)?$)/.test(req.path);
    const catalogDetail = /^\/api\/v1\/(services|doctors)\/[a-z0-9-]+$/.test(req.path);
    const booking = req.method === 'POST' && req.path === '/api/v1/appointments';
    if (booking && !fixedContacts.safeParse(req.body).success) {
      refuse(res, 400, 'INVALID_INPUT');
      return;
    }
    if (!(booking || (read && (reads.has(req.path) || catalogDetail || publicPage)))) {
      if (
        read &&
        (/^\/assets\//.test(req.path) || ['/favicon.svg', '/robots.txt'].includes(req.path))
      ) {
        next();
        return;
      }
      refuse(res, 404, 'NOT_FOUND');
      return;
    }
    const headers = new Headers();
    for (const name of [
      'origin',
      'cookie',
      'content-type',
      'x-csrf-token',
      'idempotency-key',
      'sec-fetch-site',
    ]) {
      const value = req.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('x-forwarded-for', req.socket.remoteAddress ?? '127.0.0.1');
    try {
      const response = await fetch(new URL(req.originalUrl, origin), {
        method: req.method,
        headers,
        ...(booking ? { body: JSON.stringify(req.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      res.status(response.status);
      for (const name of ['content-type', 'x-request-id', 'retry-after']) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch {
      refuse(res, 503, 'SERVICE_UNAVAILABLE');
    }
  });
  app.use(express.static(assets, { index: false, dotfiles: 'deny', fallthrough: false }));
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next; // Express identifies an error handler by its four parameters.
    const invalidJson = error instanceof SyntaxError;
    refuse(res, invalidJson ? 400 : 404, invalidJson ? 'INVALID_INPUT' : 'NOT_FOUND');
  };
  app.use(errorHandler);
  return app;
}
