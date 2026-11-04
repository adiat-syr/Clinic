import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { healthResponseSchema } from '@clinic/contracts';

const root = new URL('../', import.meta.url);
const children = [];

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function start(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'ignore', windowsHide: true });
  const state = { child, failed: false };
  child.on('error', () => {
    state.failed = true;
  });
  children.push(state);
  return state;
}

async function waitFor(url) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (children.some(({ child, failed }) => failed || child.exitCode !== null)) {
      throw new Error('Smoke subprocess exited before serving. Check build and environment.');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
    } catch {
      /* The subprocess may still be starting. */
    }
    await delay(200);
  }
  throw new Error(`Smoke request did not become healthy: ${new URL(url).pathname}`);
}

try {
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  const env = { ...process.env, API_HOST: '127.0.0.1', API_PORT: String(apiPort) };
  start(
    [`--env-file-if-exists=${fileURLToPath(new URL('.env', root))}`, 'dist/server.js'],
    fileURLToPath(new URL('apps/api', root)),
    env,
  );
  await waitFor(`http://127.0.0.1:${apiPort}/api/v1/health/live`);
  start(
    [fileURLToPath(new URL('node_modules/vite/bin/vite.js', root)), '--port', String(webPort)],
    fileURLToPath(new URL('apps/web', root)),
    env,
  );
  const webUrl = `http://127.0.0.1:${webPort}`;
  const page = await waitFor(webUrl);
  assert.match(await page.text(), /Alatau Clinic/);
  const proxyResponse = await waitFor(`${webUrl}/api/v1/health/live`);
  const health = healthResponseSchema.parse(await proxyResponse.json());
  assert.equal(health.status, 'ok');
  const readyResponse = await waitFor(`${webUrl}/api/v1/health/ready`);
  assert.equal(healthResponseSchema.parse(await readyResponse.json()).status, 'ready');
  const builtHtml = await readFile(new URL('apps/web/dist/index.html', root), 'utf8');
  assert.doesNotMatch(builtHtml, /fonts\.googleapis|cdn\.tailwindcss|googleusercontent/);
  console.log(
    'PASS: compiled API, Vite page, dev proxy, PostgreSQL readiness, local build assets.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke failed');
  process.exitCode = 1;
} finally {
  await Promise.all(
    children.map(async ({ child }) => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit').catch(() => {});
      child.kill();
      await exited;
    }),
  );
}
