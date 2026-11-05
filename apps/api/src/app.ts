import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import type { HealthResponse } from '@clinic/contracts';
import { createErrorHandler, HttpError } from './middleware/errors.js';
import { securityRouter } from './modules/security/router.js';
import type { AuthService } from './modules/security/service.js';

interface AppDependencies {
  database: { ping(): Promise<void> };
  reportUnexpected?: (requestId: string) => void;
  security?: AuthService;
}

export function createApp({ database, security, reportUnexpected = () => {} }: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet());
  app.use((_request, response, next) => {
    response.setHeader('x-request-id', randomUUID());
    response.setHeader('cache-control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/api/v1/health/live', (_request, response) => {
    const body: HealthResponse = { status: 'ok', service: 'clinic-api', dataMode: 'synthetic' };
    response.json(body);
  });

  app.get('/api/v1/health/ready', async (_request, response) => {
    try {
      await database.ping();
    } catch {
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Сервис временно недоступен');
    }
    const body: HealthResponse = { status: 'ready', service: 'clinic-api', dataMode: 'synthetic' };
    response.json(body);
  });

  if (security) app.use('/api/v1', securityRouter(security));
  app.use((_request, _response, next) => {
    next(new HttpError(404, 'NOT_FOUND', 'Ресурс не найден'));
  });
  app.use(createErrorHandler(reportUnexpected));
  return app;
}
