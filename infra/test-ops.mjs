import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const instance = process.argv[2] ?? 'stage7';
if (!/^[a-z][a-z0-9-]{2,30}$/.test(instance)) throw new Error('Invalid instance');
const root = resolve('.deploy', instance),
  envFile = resolve(root, 'compose.env'),
  text = await readFile(envFile, 'utf8');
const env = Object.fromEntries(
  text
    .split(/\r?\n/)
    .filter((v) => /^[A-Z_]+=/.test(v))
    .map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
);
if (env.DEPLOYMENT_MODE !== 'staging' || env.DATA_MODE !== 'synthetic')
  throw new Error('SYNTHETIC_STAGING_ONLY');
const drill = resolve(root, 'drill-' + Date.now());
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
async function run(args, { capture = false } = {}) {
  return new Promise((ok, bad) => {
    const p = spawn('docker', [...base, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let out = '';
    if (capture) {
      p.stdout.on('data', (b) => (out += b));
      p.stderr.resume();
    }
    p.on('error', bad);
    p.on('exit', (c) => (c === 0 ? ok(out) : bad(new Error('OPS_DRILL_FAILED'))));
  });
}
try {
  await run(['run', '--rm', '-T', 'ops-test', 'infra/tests/ops-fixture.mjs']);
  await run(['run', '--rm', '-T', 'ops-test', 'infra/tests/ops-tty.mjs']);
  await run(['run', '--rm', '-T', 'ops-restore-test', 'infra/tests/ops-restore.mjs']);
} finally {
  await run(['run', '--rm', '-T', 'ops-restore-test', 'infra/tests/ops-cleanup.mjs']);
}
const state = JSON.parse(await readFile(resolve(drill, 'state.json'), 'utf8'));
const logs = await run(['logs', '--no-color', 'postgres'], { capture: true });
if (logs.includes(state.negativeLogMarker)) throw new Error('DATABASE_LOG_PII_LEAK');
await writeFile(
  resolve('.tmp', 'ops-last-result.json'),
  JSON.stringify(
    {
      completedAt: state.completedAt,
      roleChecks: state.roleChecks,
      rotation: state.rotation,
      restoreAssertions: state.restoreAssertions,
      postgresLogsRedacted: true,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    event: 'ops_drill_complete',
    assertions: state.restoreAssertions,
    postgresLogsRedacted: true,
  }),
);
