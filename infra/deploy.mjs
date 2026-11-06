import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { validateDeployment, validateRollbackLabel } from './deployment-policy.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
const [instance, action = 'status', mode = 'staging', ...extra] = process.argv.slice(2);
if (!/^[a-z][a-z0-9-]{2,30}$/.test(instance ?? '') || !['staging', 'production'].includes(mode))
  throw new Error('Invalid instance/mode');
const envFile = resolve(
    process.env.CLINIC_DEPLOY_ROOT ??
      (mode === 'production' && process.platform === 'linux' ? '/srv/clinic' : '.deploy'),
    instance,
    'compose.env',
  ),
  text = await readFile(envFile, 'utf8');
const variables = Object.fromEntries(
  text
    .split(/\r?\n/)
    .filter((v) => /^[A-Z_]+=/.test(v))
    .map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
);
if (variables.DEPLOYMENT_MODE !== mode || variables.INSTANCE_ID !== instance)
  throw new Error('Instance mode/identity mismatch');
if (!['build', 'status', 'logs'].includes(action)) validateDeployment(variables, mode);
if (
  mode === 'staging' &&
  (variables.HTTP_BIND !== '127.0.0.1' ||
    variables.HTTPS_BIND !== '127.0.0.1' ||
    variables.DATA_MODE !== 'synthetic' ||
    variables.SITE_HOST !== 'clinic.localhost')
)
  throw new Error('Staging isolation required');
if (
  mode === 'production' &&
  !['build', 'status', 'logs', 'monitor'].includes(action) &&
  process.env.RELEASE_APPROVAL !== 'I_APPROVE_PRODUCTION_RELEASE'
)
  throw new Error('Explicit production release approval required');
const base = [
  'compose',
  '--project-name',
  'clinic-' + instance,
  '--env-file',
  envFile,
  '-f',
  'infra/compose.production.yaml',
  ...(mode === 'staging' ? ['-f', 'infra/compose.staging.yaml'] : []),
];
async function docker(args) {
  await new Promise((ok, bad) => {
    const child = spawn('docker', [...base, ...args], {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ...variables,
        ...(action === 'rollback'
          ? { API_IMAGE: process.env.API_IMAGE, WEB_IMAGE: process.env.WEB_IMAGE }
          : {}),
      },
    });
    child.on('error', bad);
    child.on('exit', (code) => (code === 0 ? ok() : bad(new Error('Docker operation failed'))));
  });
}
const ops = (command) => docker(['run', '--rm', '-T', 'provisioner', command]);
async function imageProtocol(image) {
  return new Promise((ok, bad) => {
    const p = spawn(
      'docker',
      [
        'image',
        'inspect',
        '--format',
        '{{index .Config.Labels "org.clinic.privacy-journal"}}',
        image,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    p.stdout.on('data', (b) => {
      out += b;
    });
    p.stderr.resume();
    p.on('error', bad);
    p.on('exit', (code) =>
      code === 0 ? ok(out.trim()) : bad(new Error('PINNED_ROLLBACK_IMAGE_REQUIRED')),
    );
  });
}
const release = !['status', 'logs', 'monitor', 'backup', 'cleanup', 'privacy-reconcile'].includes(
  action,
)
  ? await acquireInstanceLock(dirname(envFile))
  : async () => {};
try {
  if (action === 'build')
    await docker([
      'build',
      'api',
      'web',
      'operator',
      'backup',
      ...(mode === 'staging' ? ['tools-test-build'] : []),
    ]);
  else if (action === 'up' || action === 'update') {
    if (/SET-REAL-/.test(text)) throw new Error('Domain/contact configuration required');
    await docker(['up', '-d', '--wait', 'postgres']);
    if (action === 'update') await docker(['run', '--rm', '-T', 'backup', 'backup']);
    await ops('bootstrap');
    await ops('migrate');
    await ops('grants');
    if (/^ALLOW_DEMO_SEED=yes$/m.test(text)) await ops('demo-seed');
    await docker(['run', '--rm', '-T', 'backup', 'ledger-init']);
    await docker(['run', '--rm', '-T', 'asset-permissions']);
    await docker(['run', '--rm', '-T', 'assets']);
    await docker(['up', '-d', '--wait', 'api', 'web']);
    if (mode === 'staging') await docker(['run', '--rm', '-T', 'ca-export']);
    await docker(['up', '-d', '--wait', 'scheduler']);
  } else if (action === 'migrate') {
    await ops('migrate');
    await ops('grants');
  } else if (action === 'staff')
    await docker(['run', '--rm', 'operator', 'staff', extra[0] ?? 'bootstrap']);
  else if (action === 'consent-publish')
    await docker(['run', '--rm', '-T', 'operator', 'consent-publish', ...extra]);
  else if (action === 'anonymize')
    await docker(['run', '--rm', '-T', 'scheduler', 'anonymize', ...extra]);
  else if (action === 'backup') await docker(['run', '--rm', '-T', 'backup', 'backup']);
  else if (action === 'restore-finalize') {
    if (process.env.DATABASE_CUTOVER_APPROVAL !== 'I_APPROVE_DATABASE_CUTOVER')
      throw new Error('Explicit database cutover approval required');
    await docker(['stop', 'api', 'scheduler']);
    await docker([
      'run',
      '--rm',
      '-T',
      '-e',
      'DATABASE_CUTOVER_APPROVAL',
      'restore',
      'restore-finalize',
      ...extra,
    ]);
  } else if (action === 'restore')
    await docker(['run', '--rm', '-T', 'restore', 'restore', ...extra]);
  else if (
    [
      'cleanup',
      'monitor',
      'rotate-keys',
      'ledger-rotate-key',
      'ledger-reconcile',
      'privacy-reconcile',
    ].includes(action)
  )
    await docker([
      'run',
      '--rm',
      '-T',
      action === 'rotate-keys' ? 'rotation' : 'scheduler',
      action,
    ]);
  else if (action === 'rollback') {
    if (!process.env.API_IMAGE || !process.env.WEB_IMAGE)
      throw new Error(
        'Pin previous API_IMAGE and WEB_IMAGE; automatic database downgrade forbidden',
      );
    validateRollbackLabel(
      await imageProtocol(process.env.API_IMAGE),
      await imageProtocol(process.env.WEB_IMAGE),
    );
    await docker(['run', '--rm', '-T', 'assets']);
    await docker(['up', '-d', '--wait', '--no-build', 'api', 'web']);
  } else if (action === 'status') await docker(['ps']);
  else if (action === 'logs') await docker(['logs', '--tail', '100', 'api', 'scheduler']);
  else throw new Error('Unsupported action; destructive down -v is intentionally absent');
} finally {
  await release();
}
