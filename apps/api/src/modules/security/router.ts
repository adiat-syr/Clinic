import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthService, type StaffIdentity } from './service.js';
import { AccessError, validated } from './errors.js';
import { mac, equalMac, hashToken, token } from './crypto.js';
import { uuidSchema } from './input.js';
import { CatalogService } from '../catalog/service.js';
import { StaffService } from './staff.js';
import type { Transaction } from '../booking/transaction.js';
import { AuditService } from './audit.js';

export function readCookie(request: Request, name: string) {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]?.slice(name.length + 1) ?? '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function securityRouter(auth: AuthService) {
  const router = Router();
  const config = auth.config;
  const catalog = new CatalogService(auth.client);
  const staff = new StaffService();
  const audit = new AuditService();
  const requestId = (response: Response) =>
    String(response.getHeader('x-request-id') ?? randomUUID());
  const session = (request: Request) => readCookie(request, config.sessionCookie);
  const cookieOptions = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
  };
  const setSession = (response: Response, value: string, lifetime: number) =>
    response.cookie(config.sessionCookie, value, { ...cookieOptions, maxAge: lifetime });
  const clearSession = (response: Response) =>
    response.clearCookie(config.sessionCookie, cookieOptions);
  const csrfValue = (nonce: string, raw: string | null) =>
    mac(config.csrfKey, 'csrf-v1', `${nonce}:${raw ? hashToken(raw) : 'anonymous'}`);
  function requireCsrf(request: Request) {
    const origin = request.get('origin');
    const nonce = readCookie(request, config.csrfCookie);
    const supplied = request.get('x-csrf-token');
    if (
      origin !== config.origin ||
      request.get('sec-fetch-site') === 'cross-site' ||
      !nonce ||
      !supplied ||
      !equalMac(supplied, csrfValue(nonce, session(request)))
    )
      throw new AccessError(403, 'CSRF_FAILED');
  }
  router.use(async (request, _response, next) => {
    await auth.limiter.require(
      'api-ip',
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
      300,
      60000,
    );
    next();
  });
  router.use('/auth', (request, _response, next) => {
    if (Object.keys(request.query).length) throw new AccessError(400, 'INVALID_INPUT');
    next();
  });
  router.get('/auth/csrf', async (request, response) => {
    if (
      (request.get('origin') && request.get('origin') !== config.origin) ||
      request.get('sec-fetch-site') === 'cross-site'
    )
      throw new AccessError(403, 'CSRF_FAILED');
    const nonce = readCookie(request, config.csrfCookie) ?? token();
    response.cookie(config.csrfCookie, nonce, { ...cookieOptions, maxAge: 8 * 60 * 60000 });
    response.json({ csrfToken: csrfValue(nonce, session(request)) });
  });
  router.post('/auth/login', async (request, response) => {
    requireCsrf(request);
    const result = await auth.login(
      request.body,
      request.ip ?? 'unknown',
      requestId(response),
      session(request),
    );
    setSession(response, result.token, 5 * 60000);
    response.json({ mfaRequired: true });
  });
  router.post('/auth/mfa/verify', async (request, response) => {
    requireCsrf(request);
    const result = await auth.verifyMfa(
      session(request),
      request.body,
      request.ip ?? 'unknown',
      requestId(response),
    );
    setSession(response, result.token, 8 * 60 * 60000);
    response.json({ authenticated: true });
  });
  router.get('/auth/me', async (request, response) =>
    response.json(await auth.me(session(request), requestId(response))),
  );
  router.post('/auth/logout', async (request, response) => {
    requireCsrf(request);
    validated(z.strictObject({}), request.body ?? {});
    await auth.logout(session(request), requestId(response));
    clearSession(response);
    response.status(204).end();
  });
  router.post('/auth/password', async (request, response) => {
    requireCsrf(request);
    await auth.changePassword(session(request), request.body, requestId(response));
    clearSession(response);
    response.status(204).end();
  });

  router.get('/doctors', async (request, response) =>
    response.json(await catalog.doctors(request.query)),
  );
  router.get('/doctors/:slug', async (request, response) => {
    validated(z.strictObject({}), request.query);
    response.json(await catalog.doctor(String(request.params.slug)));
  });
  router.get('/services', async (request, response) =>
    response.json(await catalog.services(request.query)),
  );
  router.get('/services/:slug', async (request, response) => {
    validated(z.strictObject({}), request.query);
    response.json(await catalog.service(String(request.params.slug)));
  });

  async function admin<T>(
    request: Request,
    response: Response,
    work: (tx: Transaction, actor: StaffIdentity) => Promise<T>,
    options: { targets?: string[]; management?: boolean } = {},
  ) {
    if (!['GET', 'HEAD'].includes(request.method)) requireCsrf(request);
    return auth.withSession(
      session(request),
      {
        requestId: requestId(response),
        roles: ['ADMIN'],
        ...(options.targets ? { staffTargets: options.targets } : {}),
        ...(options.management ? { staffManagement: true } : {}),
      },
      async (tx, actor) => work(tx, actor),
    );
  }
  router.get('/admin/doctors', async (req, res) =>
    res.json(await admin(req, res, (tx) => catalog.doctors(req.query, true, tx))),
  );
  router.get('/admin/services', async (req, res) =>
    res.json(await admin(req, res, (tx) => catalog.services(req.query, true, tx))),
  );
  router.get('/admin/doctors/:id', async (req, res) =>
    res.json(
      await admin(req, res, (tx) => {
        validated(z.strictObject({}), req.query);
        return catalog.doctor(String(req.params.id), true, tx);
      }),
    ),
  );
  router.get('/admin/services/:id', async (req, res) =>
    res.json(
      await admin(req, res, (tx) => {
        validated(z.strictObject({}), req.query);
        return catalog.service(String(req.params.id), true, tx);
      }),
    ),
  );
  router.post('/admin/doctors', async (req, res) =>
    res.status(201).json(
      await admin(req, res, (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return catalog.createDoctor(tx, req.body, actor.id, requestId(res));
      }),
    ),
  );
  router.post('/admin/services', async (req, res) =>
    res.status(201).json(
      await admin(req, res, (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return catalog.createService(tx, req.body, actor.id, requestId(res));
      }),
    ),
  );
  router.patch('/admin/doctors/:id', async (req, res) =>
    res.json(
      await admin(req, res, (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return catalog.patchDoctor(tx, String(req.params.id), req.body, actor.id, requestId(res));
      }),
    ),
  );
  router.patch('/admin/services/:id', async (req, res) =>
    res.json(
      await admin(req, res, (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return catalog.patchService(tx, String(req.params.id), req.body, actor.id, requestId(res));
      }),
    ),
  );
  router.put('/admin/doctors/:id/services/:serviceId', async (req, res) =>
    res.json(
      await admin(req, res, (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return catalog.assignment(
          tx,
          String(req.params.id),
          String(req.params.serviceId),
          req.body,
          actor.id,
          requestId(res),
        );
      }),
    ),
  );

  router.get('/admin/staff', async (req, res) =>
    res.json(
      await admin(req, res, (tx, actor) => staff.list(tx, req.query, actor.id, requestId(res))),
    ),
  );
  router.post('/admin/staff', async (req, res) =>
    res.status(201).json(
      await admin(
        req,
        res,
        (tx, actor) => {
          validated(z.strictObject({}), req.query);
          return staff.create(tx, req.body, actor.id, requestId(res));
        },
        { management: true },
      ),
    ),
  );
  router.patch('/admin/staff/:id', async (req, res) => {
    const id = validated(uuidSchema, req.params.id);
    const result = await admin(
      req,
      res,
      (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return staff.patch(tx, id, req.body, actor.id, requestId(res));
      },
      { management: true, targets: [id] },
    );
    res.json(result);
  });
  router.post('/admin/staff/:id/revoke-sessions', async (req, res) => {
    const id = validated(uuidSchema, req.params.id);
    await admin(
      req,
      res,
      (tx, actor) => {
        validated(z.strictObject({}), req.query);
        validated(z.strictObject({}), req.body ?? {});
        return staff.revoke(tx, id, actor.id, requestId(res), auth.now());
      },
      { management: true, targets: [id] },
    );
    res.status(204).end();
  });
  router.get('/admin/staff/:id', async (req, res) =>
    res.json(
      await admin(req, res, (tx, actor) => {
        validated(z.strictObject({}), req.query);
        return staff.get(tx, req.params.id, actor.id, requestId(res));
      }),
    ),
  );
  router.get('/admin/audit-events', async (req, res) =>
    res.json(
      await admin(req, res, (tx, actor) =>
        audit.list(tx, req.query, actor.id, requestId(res), auth.now()),
      ),
    ),
  );
  return router;
}
