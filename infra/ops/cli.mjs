import { bootstrap, migrate, grants } from './database.mjs';
import { backup, restore, finalizeRestore } from './backup.mjs';
import { cleanup, anonymize } from './maintenance.mjs';
import { rotateKeys } from './rotation.mjs';
import { secret, run, log } from './lib.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'bootstrap') await bootstrap();
  else if (command === 'ledger-init') {
    const { ledgerSnapshot } = await import('./ledger.mjs');
    try {
      await ledgerSnapshot();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const { database } = await import('./lib.mjs');
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(process.env.BACKUP_DIR ?? '/backups').catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      });
      if (files.some((f) => f.endsWith('.gcm')))
        throw new Error('EXISTING_HISTORY_REQUIRES_LEDGER_RECOVERY', { cause: e });
      const db = await database();
      try {
        if (
          (
            await db.query(
              "SELECT 1 FROM appointments WHERE anonymized_at IS NOT NULL UNION ALL SELECT 1 FROM audit_events WHERE action IN ('APPOINTMENT_ANONYMIZED','CONSENT_WITHDRAWAL_RECORDED') LIMIT 1",
            )
          ).rowCount
        )
          throw new Error('EXISTING_HISTORY_REQUIRES_LEDGER_RECOVERY', { cause: e });
      } finally {
        await db.end();
      }
      await ledgerSnapshot({ initialize: true });
    }
    log('ledger_initialized');
  } else if (command === 'ledger-reconcile') {
    const { reconcileLedger } = await import('./ledger.mjs');
    log('ledger_reconciled', await reconcileLedger());
  } else if (command === 'ledger-rotate-key') {
    const { rotateLedgerKey } = await import('./ledger.mjs');
    log('ledger_key_rotated', await rotateLedgerKey());
  } else if (command === 'migrate') await migrate();
  else if (command === 'grants') await grants();
  else if (command === 'consent-publish') {
    if (args.length !== 1) throw new Error('LOCAL_DOCUMENT_REQUIRED');
    await run(
      process.execPath,
      ['--import', 'tsx', 'apps/api/scripts/consent.ts', args[0]],
      process.env,
      { inherit: true },
    );
  } else if (command === 'backup') await backup();
  else if (command === 'restore-finalize') await finalizeRestore(args[0] ?? '');
  else if (command === 'restore') await restore(args[0] ?? '', args[1] ?? '');
  else if (command === 'cleanup') await cleanup();
  else if (command === 'privacy-reconcile') {
    const { reconcilePrivacy } = await import('./reconcile-privacy.mjs');
    await reconcilePrivacy();
  } else if (command === 'anonymize') await anonymize(args[0] ?? '', args[1]);
  else if (command === 'rotate-keys') await rotateKeys();
  else if (command === 'staff') {
    if (
      !['bootstrap', 'credentials', 'recover-admin', 'change-email'].includes(args[0] ?? '') ||
      args.length !== 1 ||
      !process.stdin.isTTY
    )
      throw new Error('PRIVATE_TTY_REQUIRED');
    await run(
      process.execPath,
      ['--import', 'tsx', 'apps/api/scripts/staff.ts', args[0]],
      process.env,
      { inherit: true },
    );
  } else if (command === 'demo-seed') {
    if (process.env.DATA_MODE !== 'synthetic' || process.env.ALLOW_DEMO_SEED !== 'yes')
      throw new Error('SYNTHETIC_ONLY');
    const { createPrisma } = await import('../../apps/api/dist/infrastructure/prisma.js');
    const { seedSyntheticClinic } = await import('../../apps/api/dist/testing/synthetic-clinic.js');
    const db = createPrisma(await secret('MIGRATION_DATABASE_URL'));
    try {
      const day = new Date();
      day.setUTCDate(day.getUTCDate() + 1);
      await seedSyntheticClinic(db, day, new Date());
    } finally {
      await db.$disconnect();
    }
    log('synthetic_demo_seeded');
  } else if (command === 'monitor') {
    const { monitor } = await import('./monitor.mjs');
    if (!(await monitor()).ok) process.exitCode = 2;
  } else if (command === 'scheduler') {
    const { scheduler } = await import('./monitor.mjs');
    await scheduler();
  } else throw new Error('UNKNOWN_OPERATION');
} catch (error) {
  log('operation_failed', {
    operation: command ?? 'none',
    code: /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'OPERATION_FAILED',
  });
  process.exitCode = 1;
}
