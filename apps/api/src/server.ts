import { createApp } from './app.js';
import { ConfigurationError, parseEnvironment } from './config/env.js';
import { createDatabase } from './infrastructure/database.js';

function logEvent(level: 'info' | 'error', event: string, requestId?: string) {
  const output = JSON.stringify({ level, event, ...(requestId ? { requestId } : {}) });
  if (level === 'error') console.error(output);
  else console.log(output);
}

try {
  const config = parseEnvironment(process.env);
  const database = createDatabase(config.DATABASE_URL, () =>
    logEvent('error', 'database_pool_error'),
  );
  const app = createApp({
    database,
    reportUnexpected: (requestId) => logEvent('error', 'unexpected_request_error', requestId),
  });
  const server = app.listen(config.API_PORT, config.API_HOST, () => {
    logEvent('info', 'api_listening');
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
    }, 10_000);
    deadline.unref();
    server.closeIdleConnections();
    server.close(() => {
      void database.close().then(
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
    void database.close();
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
