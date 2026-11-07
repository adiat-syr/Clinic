import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { bootstrap, migrate, grants } from '../ops/database.mjs';
import { ledgerSnapshot } from '../ops/ledger.mjs';
import { createPrisma } from '../../apps/api/dist/infrastructure/prisma.js';
import { seedSyntheticClinic, syntheticIds } from '../../apps/api/dist/testing/synthetic-clinic.js';
import { BookingService } from '../../apps/api/dist/modules/booking/service.js';
import { lockDoctors } from '../../apps/api/dist/modules/booking/repository.js';

try {
  if (process.env.DATA_MODE !== 'synthetic' || process.env.DEMO_RELEASE !== 'synthetic-portfolio')
    throw new Error('SYNTHETIC_PORTFOLIO_ONLY');
  const url = new URL(process.env.DEMO_BOOTSTRAP_URL);
  if (url.pathname !== '/clinic_demo') throw new Error('DEDICATED_DEMO_DATABASE_REQUIRED');
  const root = process.env.DEMO_STATE_DIR ?? '/data';
  const secretDir = join(root, 'secrets');
  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  const secretsFile = join(secretDir, 'state.json');
  let state;
  try {
    state = JSON.parse(await readFile(secretsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const probe = createPrisma(url.href, 1);
    try {
      const rows =
        await probe.$queryRaw`SELECT to_regclass('public.appointments')::text AS present`;
      if (rows[0]?.present)
        throw new Error('EXISTING_DATABASE_REQUIRES_ITS_ORIGINAL_KEYS', { cause: error });
    } finally {
      await probe.$disconnect();
    }
    state = {
      roles: Object.fromEntries(
        [
          'clinic_migrator',
          'clinic_runtime',
          'clinic_operator',
          'clinic_maintenance',
          'clinic_backup',
        ].map((role) => [role, randomBytes(32).toString('hex')]),
      ),
      mfa: randomBytes(32).toString('hex'),
      csrf: randomBytes(32).toString('hex'),
      contact: randomBytes(32).toString('hex'),
      hmac: randomBytes(32).toString('hex'),
      ledger: randomBytes(32).toString('hex'),
    };
    await writeFile(secretsFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  }
  const file = async (name, value) => {
    const path = join(secretDir, name);
    await writeFile(path, value + '\n', { mode: 0o600 });
    return path;
  };
  const roleUrl = (role) => {
    const target = new URL(url);
    target.username = role;
    target.password = state.roles[role];
    return target.href;
  };
  process.env.NODE_ENV = 'production';
  process.env.BOOTSTRAP_DATABASE_URL_FILE = await file('bootstrap-url', url.href);
  process.env.MIGRATION_DATABASE_URL_FILE = await file('migrator-url', roleUrl('clinic_migrator'));
  process.env.ROLE_PASSWORDS_FILE = await file('role-passwords', JSON.stringify(state.roles));
  process.env.DATABASE_URL_FILE = await file('runtime-url', roleUrl('clinic_runtime'));
  delete process.env.DATABASE_URL;
  await bootstrap();
  await migrate();
  await grants();

  const db = createPrisma(roleUrl('clinic_migrator'), 2);
  try {
    const tomorrow = new Date(Date.now() + 86400000);
    await seedSyntheticClinic(db, tomorrow, new Date());
    const core = new BookingService(db, { idempotencySecret: Buffer.from(state.hmac, 'hex') });
    for (let day = 1; day <= 59; day++) {
      const startsAt = new Date(Date.now() + day * 86400000);
      startsAt.setUTCHours(4, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600000);
      for (const doctorId of syntheticIds.doctors) {
        await db.$transaction(async (tx) => {
          await lockDoctors(tx, [doctorId]);
          const exists = await tx.availabilityWindow.findFirst({
            where: { doctorId, startsAt: { gte: startsAt, lt: endsAt } },
          });
          if (!exists)
            await core.inTransaction(tx, syntheticIds.staff, randomUUID()).createWindow({
              doctorId,
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
            });
        });
      }
    }
  } finally {
    await db.$disconnect();
  }

  process.env.AUTH_MFA_KEY_FILE = await file('mfa', state.mfa);
  process.env.AUTH_CSRF_KEY_FILE = await file('csrf', state.csrf);
  process.env.CONTACT_KEY_VERSION = 'portfolio-v1';
  process.env.CONTACT_KEYS_JSON_FILE = await file(
    'contacts',
    JSON.stringify({ 'portfolio-v1': state.contact }),
  );
  process.env.BOOKING_HMAC_KEY_FILE = await file('hmac', state.hmac);
  process.env.DELETION_LEDGER_KEY_FILE = await file('ledger', state.ledger);
  process.env.DELETION_LEDGER_DIR = join(root, 'ledger');
  process.env.LEDGER_CHECKPOINT_DIR = join(root, 'checkpoint');
  await ledgerSnapshot({ initialize: true });
  // Refuse an ephemeral state directory; keys must survive application restarts.
  if (!(await stat(root)).isDirectory()) throw new Error('PERSISTENT_STATE_REQUIRED');
  const runtime = { ...process.env };
  for (const name of [
    'DEMO_BOOTSTRAP_URL',
    'BOOTSTRAP_DATABASE_URL_FILE',
    'MIGRATION_DATABASE_URL_FILE',
    'ROLE_PASSWORDS_FILE',
  ])
    delete runtime[name];
  const child = spawn(process.execPath, ['apps/api/dist/portfolio/server.js'], {
    env: runtime,
    stdio: 'inherit',
    windowsHide: true,
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    console.error('{"event":"portfolio_process_failed"}');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch {
  console.error('{"event":"portfolio_bootstrap_failed"}');
  process.exitCode = 1;
}
