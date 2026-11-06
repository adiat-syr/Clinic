import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { checkServerIdentity } from 'node:tls';
import assert from 'node:assert/strict';
import { acquireInstanceLock } from './instance-lock.mjs';
const instance = process.argv[2] ?? 'stage7';
if (!/^[a-z][a-z0-9-]{2,30}$/.test(instance)) throw new Error('Invalid staging instance');
const root = resolve('.deploy', instance),
  envFile = resolve(root, 'compose.env'),
  text = await readFile(envFile, 'utf8');
const env = Object.fromEntries(
  text
    .split(/\r?\n/)
    .filter((v) => /^[A-Z_]+=/.test(v))
    .map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
);
assert.equal(env.DEPLOYMENT_MODE, 'staging');
assert.equal(env.DATA_MODE, 'synthetic');
assert.equal(env.HTTP_BIND, '127.0.0.1');
assert.equal(env.HTTPS_BIND, '127.0.0.1');
const drill = resolve(root, 'https-' + Date.now());
await mkdir(drill, { recursive: true, mode: 0o700 });
env.DRILL_DIR = drill.replaceAll('\\', '/');
const base = [
  'compose',
  '--project-name',
  'clinic-' + instance,
  '--env-file',
  envFile,
  '-f',
  'infra/compose.production.yaml',
  '-f',
  'infra/compose.staging.yaml',
];
async function command(binary, args, extra = {}) {
  await new Promise((ok, bad) => {
    const p = spawn(binary, args, {
      env: { ...process.env, ...env, ...extra },
      windowsHide: true,
      stdio: 'inherit',
    });
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error('HTTPS_CHECK_FAILED'))));
  });
}
const docker = (args, override = false) =>
  command('docker', [
    ...base,
    ...(override ? ['-f', resolve(drill, 'override.json')] : []),
    ...args,
  ]);
const release = await acquireInstanceLock(root);
let switched = false;
try {
  await docker([
    'run',
    '--rm',
    '-T',
    '-e',
    'HTTPS_FIXTURE=1',
    'ops-test',
    'infra/tests/ops-fixture.mjs',
  ]);
  await writeFile(
    resolve(drill, 'override.json'),
    JSON.stringify({
      services: {
        api: {
          environment: { DATABASE_URL_FILE: '/drill/database_url' },
          volumes: [env.DRILL_DIR + ':/drill:ro'],
        },
      },
    }),
  );
  switched = true;
  await docker(['up', '-d', '--no-deps', '--wait', 'api'], true);
  const ca = await readFile(resolve(env.TLS_PUBLIC_DIR, 'root.crt'));
  const certificate = await new Promise((ok, bad) => {
    const req = https.get(
      {
        hostname: '127.0.0.1',
        port: Number(env.HTTPS_PORT),
        servername: env.SITE_HOST,
        ca,
        checkServerIdentity: (_host, cert) => checkServerIdentity(env.SITE_HOST, cert),
        path: '/api/v1/health/ready',
        timeout: 5000,
      },
      (res) => {
        res.resume();
        assert.equal(res.statusCode, 200);
        assert.equal(res.socket.authorized, true);
        ok({
          subject: res.socket.getPeerCertificate().subject.CN,
          expires: res.socket.getPeerCertificate().valid_to,
        });
      },
    );
    req.on('error', bad);
    req.on('timeout', () => req.destroy());
  });
  await new Promise((ok, bad) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: Number(env.HTTP_PORT),
        headers: { host: env.SITE_HOST },
        path: '/ru',
      },
      (res) => {
        res.resume();
        try {
          assert.ok([301, 308].includes(res.statusCode));
          assert.equal(res.headers.location, env.PUBLIC_ORIGIN + '/ru');
          ok();
        } catch (e) {
          bad(e);
        }
      },
    );
    req.on('error', bad);
  });
  console.log(
    JSON.stringify({
      event: 'https_chain_hostname_redirect_verified',
      certificateExpires: certificate.expires,
    }),
  );
  await command(
    process.execPath,
    ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.https.config.ts'],
    { WEB_HTTPS_BASE: env.PUBLIC_ORIGIN, WEB_HTTPS_STATE_FILE: resolve(drill, 'state.json') },
  );
  const times = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < 40) {
        const i = next++,
          at = performance.now();
        await new Promise((ok, bad) => {
          const req = https.get(
            {
              hostname: '127.0.0.1',
              port: Number(env.HTTPS_PORT),
              servername: env.SITE_HOST,
              ca,
              checkServerIdentity: (_host, cert) => checkServerIdentity(env.SITE_HOST, cert),
              path: i % 2 ? '/ru/services' : '/api/v1/health/ready',
              timeout: 10000,
            },
            (res) => {
              res.resume();
              res.on('end', () =>
                res.statusCode === 200 ? ok() : bad(new Error('HTTPS_LOAD_STATUS_FAILED')),
              );
            },
          );
          req.on('error', bad);
          req.on('timeout', () => req.destroy(new Error('HTTPS_LOAD_TIMEOUT')));
        });
        times.push(performance.now() - at);
      }
    }),
  );
  times.sort((a, b) => a - b);
  const result = {
    completedAt: new Date().toISOString(),
    browserTests: 4,
    requests: times.length,
    concurrency: 4,
    p95Ms: Math.round(times[Math.ceil(times.length * 0.95) - 1]),
    maxMs: Math.round(times.at(-1)),
    durationMs: Math.round(performance.now() - started),
    tlsChainVerified: true,
  };
  await mkdir('.tmp', { recursive: true });
  await writeFile('.tmp/https-last-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ event: 'synthetic_https_load_verified', ...result }));
} finally {
  try {
    if (switched) await docker(['up', '-d', '--no-deps', '--wait', 'api']);
    await docker(['run', '--rm', '-T', 'ops-restore-test', 'infra/tests/ops-cleanup.mjs']);
  } finally {
    await release();
  }
}
