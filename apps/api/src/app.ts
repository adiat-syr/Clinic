import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import type { HealthResponse } from '@clinic/contracts';
import { createErrorHandler, HttpError } from './middleware/errors.js';
import { securityRouter } from './modules/security/router.js';
import type { AuthService } from './modules/security/service.js';
import type { BookingHttpService } from './modules/booking/http-service.js';
import { demoProfile, type ClinicProfile } from './config/clinic.js';
import { isIP } from 'node:net';

interface AppDependencies {
  database: { ping(): Promise<void> };
  reportUnexpected?: (requestId: string) => void;
  security?: AuthService;
  booking?: BookingHttpService;
  clinic?: ClinicProfile;
  dataMode?: 'synthetic' | 'clinic';
  trustedProxies?: string[];
  site?: { render(path: string): Promise<{ status: number; html: string }>; invalidate?(): void };
}

export function createApp({
  database,
  security,
  booking,
  clinic = demoProfile,
  dataMode = 'synthetic',
  trustedProxies = [],
  site,
  reportUnexpected = () => {},
}: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  if (
    trustedProxies.some(
      (v) =>
        !isIP(v.split('/')[0] ?? '') ||
        (v.includes('/') && v.split('/')[1] !== (isIP(v.split('/')[0] ?? '') === 4 ? '32' : '128')),
    )
  )
    throw new Error('Invalid trusted proxies');
  app.set('trust proxy', trustedProxies.length ? trustedProxies : false);
  app.use(helmet());
  app.use((_request, response, next) => {
    response.setHeader('x-request-id', randomUUID());
    response.setHeader('cache-control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/api/v1/health/live', (_request, response) => {
    const body: HealthResponse = { status: 'ok', service: 'clinic-api', dataMode };
    response.json(body);
  });

  app.get('/api/v1/health/ready', async (_request, response) => {
    try {
      await database.ping();
    } catch {
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Сервис временно недоступен');
    }
    const body: HealthResponse = { status: 'ready', service: 'clinic-api', dataMode };
    response.json(body);
  });

  app.get('/api/v1/clinic', (_req, res) =>
    res.json({
      ...clinic,
      phoneConsentEnabled: booking?.phoneConsentAllowed ?? false,
      bookingEnabled: booking?.onlineBookingAllowed ?? false,
    }),
  );
  if (security)
    app.use(
      '/api/v1',
      securityRouter(security, booking, () => site?.invalidate?.()),
    );
  let rendering = 0;
  if (site)
    app.get(/^\/(?:$|(?:ru|kk)(?:\/.*)?$)/, async (req, res) => {
      if (rendering >= 4)
        throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Сервис временно недоступен');
      rendering++;
      try {
        if (security) await security.limiter.require('site-ip', req.ip ?? 'unknown', 120, 60000);
        const page = await site.render(req.path);
        res.status(page.status).type('html').send(page.html);
      } finally {
        rendering--;
      }
    });
  app.use((_request, _response, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'Ресурс не найден'));
  });
  app.use(createErrorHandler(reportUnexpected));
  return app;
}
