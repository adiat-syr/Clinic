import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root = fileURLToPath(new URL('../', import.meta.url)),
  source = new URL(process.env.DATABASE_URL);
if (
  process.env.DATA_MODE !== 'synthetic' ||
  process.env.NODE_ENV === 'production' ||
  !['localhost', '127.0.0.1'].includes(source.hostname)
)
  throw new Error('Local synthetic database required');
const name = 'clinic_test_' + randomUUID().replaceAll('-', ''),
  target = new URL(source);
target.pathname = '/' + name;
const admin = new pg.Client({ connectionString: source.href }),
  children = [];
let created = false;
async function port() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const address = s.address();
  if (!address || typeof address === 'string') throw new Error('Port unavailable');
  await new Promise((r) => s.close(r));
  return address.port;
}
const apiPort = await port(),
  webPort = await port(),
  env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: target.href,
    TEST_DATABASE_URL: target.href,
    API_PORT: String(apiPort),
    AUTH_ORIGIN: `http://127.0.0.1:${webPort}`,
    WEB_TEST_BASE: `http://127.0.0.1:${webPort}`,
    WEB_TEST_DATE: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  };
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: 'inherit' });
  children.push(child);
  return child;
}
async function run(args) {
  const child = start(args);
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('Web test subprocess failed');
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready');
}
try {
  await admin.connect();
  const version = await admin.query('SHOW server_version');
  if (!version.rows[0].server_version.startsWith('18.6'))
    throw new Error('PostgreSQL 18.6 required');
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await run([
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    'apps/api/prisma.config.ts',
  ]);
  await run(['--import', 'tsx', 'apps/api/prisma/seed.ts']);
  start(['apps/api/dist/server.js']);
  await ready(`http://127.0.0.1:${apiPort}/api/v1/health/ready`);
  start(
    [
      fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
      '--port',
      String(webPort),
      '--strictPort',
    ],
    fileURLToPath(new URL('../apps/web', import.meta.url)),
  );
  await ready(env.WEB_TEST_BASE);
  await run(['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)]);
} catch {
  console.error('Browser checks failed; no credentials were logged.');
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
  }
  if (created) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [
      name,
    ]);
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await admin.end();
  console.log('Owned browser-test database cleaned up.');
}
