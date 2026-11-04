import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { parseEnvironment } from '../src/config/env.js';

const config = parseEnvironment(process.env);
const sourceUrl = new URL(config.DATABASE_URL);
if (
  config.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(sourceUrl.hostname)
) {
  throw new Error('Integration runner requires a local synthetic PostgreSQL');
}
const name = `clinic_test_${randomUUID().replaceAll('-', '')}`;
if (!/^clinic_test_[a-f0-9]{32}$/.test(name))
  throw new Error('Unsafe generated test database name');
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${name}`;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const admin = new pg.Pool({ connectionString: sourceUrl.toString(), max: 1 });
let created = false;
let phase = 'create-database';

async function run(script: string, args: string[]) {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: testUrl.toString(),
        TEST_DATABASE_URL: testUrl.toString(),
      },
    });
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error('Integration subprocess failed');
}

try {
  const version = await admin.query<{ server_version: string }>('SHOW server_version');
  if (!/^18\.6(?:\s|$)/.test(version.rows[0]?.server_version ?? ''))
    throw new Error('Expected PostgreSQL 18.6');
  // Identifier is generated above and strictly validated; user-controlled identifiers never enter SQL.
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  phase = 'migrate';
  const cli = require.resolve('prisma/build/index.js');
  const args = ['migrate', 'deploy', '--config', 'apps/api/prisma.config.ts'];
  await run(cli, args);
  await run(cli, args); // Re-application must be a no-op; custom SQL remains installed.
  phase = 'tests';
  await run(join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), [
    'run',
    '--config',
    'vitest.integration.config.ts',
  ]);
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'SUBPROCESS_FAILED';
  console.error(JSON.stringify({ event: 'integration_failed', phase, code }));
  process.exitCode = 1;
} finally {
  if (created) {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await admin.query(`DROP DATABASE "${name}"`);
    console.log(
      'Owned temporary integration database removed; application database was not reset.',
    );
  }
  await admin.end();
}
