import { createApp } from './app.js';
import { ConfigurationError, parseEnvironment } from './config/env.js';
import { createDatabase } from './infrastructure/database.js';
import { createPrisma } from './infrastructure/prisma.js';
import { parseSecurityEnvironment } from './modules/security/config.js';
import { AuthService } from './modules/security/service.js';
import { BookingHttpService, type WithdrawalJournal } from './modules/booking/http-service.js';
import { z } from 'zod';
import { parsePrivacyEnvironment } from './modules/booking/privacy.js';
import { loadSecretFiles } from './config/secrets.js';
import {
  loadClinicProfile,
  phoneConsentEnabled,
  approvedConsentHash,
  verifyClinicData,
  publicBookingEnabled,
} from './config/clinic.js';
import { verifyRuntimeDatabase } from './infrastructure/runtime-check.js';
import { SiteService } from './modules/site/service.js';
import { CatalogService } from './modules/catalog/service.js';

function logEvent(level: 'info' | 'error', event: string, requestId?: string) {
  const output = JSON.stringify({ level, event, ...(requestId ? { requestId } : {}) });
  if (level === 'error') console.error(output);
  else console.log(output);
}

try {
  loadSecretFiles();
  const config = parseEnvironment(process.env);
  const clinic = loadClinicProfile(process.env);
  const securityConfig = parseSecurityEnvironment(process.env);
  const prisma = createPrisma(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
  if (config.NODE_ENV === 'production') await verifyRuntimeDatabase(prisma);
  await verifyClinicData(prisma, process.env);
  const security = new AuthService(prisma, securityConfig);
  const booking = new BookingHttpService(
    prisma,
    parsePrivacyEnvironment(process.env),
    undefined,
    approvedConsentHash(process.env),
  );
  booking.phoneConsentAllowed = phoneConsentEnabled(process.env);
  booking.onlineBookingAllowed = publicBookingEnabled(process.env);
  if (config.NODE_ENV === 'production') {
    const path = new URL('../../../infra/ops/withdrawal.mjs', import.meta.url).href;
    const adapter = await import(path);
    await adapter.verifyWithdrawalJournal();
    booking.withdrawalJournal = z
      .custom<WithdrawalJournal>(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          'withLock' in v &&
          typeof v.withLock === 'function' &&
          'record' in v &&
          typeof v.record === 'function',
      )
      .parse(adapter.createWithdrawalJournal());
  }
  await security.ready();
  const database = createDatabase(config.DATABASE_URL, () =>
    logEvent('error', 'database_pool_error'),
  );
  const app = createApp({
    database,
    security,
    booking,
    clinic,
    dataMode: config.DATA_MODE,
    ...(config.NODE_ENV === 'production'
      ? {
          site: new SiteService(
            new CatalogService(prisma),
            {
              ...clinic,
              phoneConsentEnabled: booking.phoneConsentAllowed,
              bookingEnabled: booking.onlineBookingAllowed,
            },
            securityConfig.origin,
          ),
        }
      : {}),
    trustedProxies: config.TRUSTED_PROXY_CIDRS.split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    reportUnexpected: (requestId) => logEvent('error', 'unexpected_request_error', requestId),
  });
  const server = app.listen(config.API_PORT, config.API_HOST, () => {
    logEvent('info', 'api_listening');
    if (config.NODE_ENV !== 'production')
      console.log(`Local API: http://${config.API_HOST}:${config.API_PORT}`);
  });

  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    logEvent('info', 'shutdown_started');
    const deadline = setTimeout(() => {
      logEvent('error', 'shutdown_timeout');
      process.exit(1);
    }, 25_000);
    deadline.unref();
    server.closeIdleConnections();
    server.close(() => {
      void Promise.all([database.close(), prisma.$disconnect()]).then(
        () => {
          clearTimeout(deadline);
          logEvent('info', 'shutdown_complete');
        },
        () => {
          clearTimeout(deadline);
          logEvent('error', 'shutdown_failed');
          process.exitCode = 1;
        },
      );
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('error', () => {
    logEvent('error', 'listen_failed');
    process.exitCode = 1;
    void Promise.all([database.close(), prisma.$disconnect()]);
  });
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(
      JSON.stringify({ level: 'error', event: 'invalid_environment', fields: error.fields }),
    );
  } else {
    console.error(JSON.stringify({ level: 'error', event: 'startup_failed' }));
  }
  process.exitCode = 1;
}
