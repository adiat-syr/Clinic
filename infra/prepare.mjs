import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const [instance, mode = 'staging'] = process.argv.slice(2);
if (process.platform !== 'win32' && process.getuid?.() === 0)
  throw new Error('Run preparation as the unprivileged deployment user');
if (!/^[a-z][a-z0-9-]{2,30}$/.test(instance ?? '') || !['staging', 'production'].includes(mode))
  throw new Error('Usage: node infra/prepare.mjs instance-id staging|production');
const root = resolve(
    process.env.CLINIC_DEPLOY_ROOT ??
      (mode === 'production' && process.platform === 'linux' ? '/srv/clinic' : '.deploy'),
    instance,
  ),
  secrets = join(root, 'secrets'),
  config = join(root, 'config');
try {
  await stat(join(root, 'compose.env'));
  throw new Error('Instance already prepared; existing secrets will not be overwritten');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await mkdir(secrets, { recursive: true, mode: 0o700 });
await mkdir(config, { recursive: true, mode: 0o700 });
const passwords = Object.fromEntries(
  [
    'clinic_bootstrap',
    'clinic_migrator',
    'clinic_runtime',
    'clinic_operator',
    'clinic_maintenance',
    'clinic_backup',
  ].map((n) => [n, randomBytes(32).toString('hex')]),
);
const writes = {
  postgres_password: passwords.clinic_bootstrap,
  role_passwords: JSON.stringify(passwords),
  mfa_key: randomBytes(32).toString('hex'),
  csrf_key: randomBytes(32).toString('hex'),
  hmac_key: randomBytes(32).toString('hex'),
  contact_keys: JSON.stringify({ v1: randomBytes(32).toString('hex') }),
  backup_key: randomBytes(32).toString('hex'),
  backup_keys: JSON.stringify({ v1: randomBytes(32).toString('hex') }),
  ledger_key: randomBytes(32).toString('hex'),
  ledger_keys: JSON.stringify({ v1: randomBytes(32).toString('hex') }),
};
writes.mfa_keys = JSON.stringify({ v1: randomBytes(32).toString('hex') });
for (const [name, role] of Object.entries({
  bootstrap_url: 'clinic_bootstrap',
  migrator_url: 'clinic_migrator',
  runtime_url: 'clinic_runtime',
  operator_url: 'clinic_operator',
  maintenance_url: 'clinic_maintenance',
  backup_url: 'clinic_backup',
}))
  writes[name] = `postgresql://${role}:${passwords[role]}@postgres:5432/clinic`;
for (const [name, value] of Object.entries(writes))
  await writeFile(join(secrets, name), value + '\n', { flag: 'wx', mode: 0o600 });
const demo = JSON.parse(await readFile('infra/clinic.demo.json', 'utf8'));
await writeFile(join(config, 'clinic.json'), JSON.stringify(demo, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(
  join(config, 'retention.json'),
  JSON.stringify(
    {
      approved: false,
      decisionReference: '',
      technicalGraceSeconds: 3600,
      backupRetentionDays: 30,
      appointmentRetentionDays: null,
      unclaimedReceiptRetentionMinutes: null,
      withdrawalErasureApproved: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx', mode: 0o600 },
);
const path = (p) => p.replaceAll('\\', '/');
const env = `INSTANCE_ID=${instance}\nCONFIG_DIR=${path(config)}\nSECRETS_DIR=${path(secrets)}\nSITE_HOST=${mode === 'staging' ? 'clinic.localhost' : 'SET-REAL-DOMAIN'}\nACME_EMAIL=${mode === 'staging' ? 'operator@example.invalid' : 'SET-OPERATOR-EMAIL'}\nPUBLIC_ORIGIN=${mode === 'staging' ? 'https://clinic.localhost:8443' : 'https://SET-REAL-DOMAIN'}\nHTTP_BIND=${mode === 'staging' ? '127.0.0.1' : '0.0.0.0'}\nHTTPS_BIND=${mode === 'staging' ? '127.0.0.1' : '0.0.0.0'}\nHTTP_PORT=${mode === 'staging' ? '8080' : '80'}\nHTTPS_PORT=${mode === 'staging' ? '8443' : '443'}\nDATA_MODE=synthetic\nCLINIC_TIME_ZONE=Asia/Almaty\nBACKEND_SUBNET=172.30.42.0/24\nPROXY_IP=172.30.42.10\nTLS_PUBLIC_DIR=${path(join(root, 'tls'))}\nROBOTS_POLICY=noindex\nALLOW_DEMO_SEED=no\nBACKUP_DIR=${path(join(root, 'backups'))}\nSECONDARY_BACKUP_DIR=${path(join(root, 'secondary-backups'))}\nLEDGER_DIR=${path(join(root, 'ledger'))}\nLEDGER_CHECKPOINT_DIR=${path(join(root, 'ledger-checkpoint'))}\n`;
await writeFile(join(root, 'compose.env'), env, { flag: 'wx', mode: 0o600 });
await writeFile(
  join(root, 'compose.env'),
  `DEPLOYMENT_MODE=${mode}\nAPP_UID=${process.getuid?.() ?? 1000}\nAPP_GID=${process.getgid?.() ?? 1000}\n` +
    env,
  { mode: 0o600 },
);
await mkdir(join(root, 'backups'), { recursive: true, mode: 0o700 });
await mkdir(join(root, 'ledger'), { recursive: true, mode: 0o700 });
console.log(
  JSON.stringify({
    event: 'instance_prepared',
    instance,
    mode,
    configuration: path(join(root, 'compose.env')),
    secretsPrinted: false,
    reference: randomUUID(),
  }),
);

for (const dir of ['secondary-backups', 'ledger-checkpoint', 'tls'])
  await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
