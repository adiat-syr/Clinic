import { ledgerKey } from './ledger-keys.mjs';
import { join, basename } from 'node:path';
import { readdir, mkdtemp, rm, stat, copyFile, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  database,
  secret,
  run,
  pgEnvironment,
  encryptFile,
  decryptFile,
  fileHash,
  atomicJson,
  readFile,
  mkdir,
  unlink,
  log,
  identifier,
  signRecord,
  verifyRecord,
  syncDirectory,
} from './lib.mjs';
import { replayLedger, checkIntegrity, readPolicy } from './maintenance.mjs';
import { ledgerSnapshot, prefixDigest, withRegistryLock } from './ledger.mjs';
import { backupKey } from './backup-keys.mjs';

export async function backup() {
  const dir = process.env.BACKUP_DIR ?? '/backups';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(tmpdir(), 'clinic-backup-'));
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID(),
    archive = join(dir, id + '.gcm');
  try {
    const name = process.env.BACKUP_DATABASE_URL_FILE ? 'BACKUP_DATABASE_URL' : 'DATABASE_URL';
    const url = await secret(name),
      env = await pgEnvironment(url),
      db = await database(name),
      tx = await db.connect();
    let integrity;
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      integrity = await checkIntegrity(tx);
      const snapshot = (await tx.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      await run(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '--snapshot',
          snapshot,
          '--file',
          join(temporary, 'database.dump'),
        ],
        env,
      );
      await tx.query('COMMIT');
    } catch (e) {
      await tx.query('ROLLBACK');
      throw e;
    } finally {
      tx.release();
      await db.end();
    }
    await run('pg_restore', ['--list', join(temporary, 'database.dump')], env);
    const selectedKey = await backupKey(),
      encryptionKey = selectedKey.key;
    if (encryptionKey.equals((await ledgerKey()).key)) throw new Error('PURPOSE_KEYS_MUST_DIFFER');
    await encryptFile(join(temporary, 'database.dump'), archive, encryptionKey);
    const ledger = await ledgerSnapshot();
    const manifest = {
      version: 2,
      keyVersion: selectedKey.version,
      createdAt: new Date().toISOString(),
      sha256: await fileHash(archive),
      integrity,
      ledgerId: ledger.id,
      ledgerCount: ledger.entries.length,
      ledgerPrefix: prefixDigest(ledger),
    };
    manifest.mac = signRecord('clinic:backup-manifest:v2', manifest, encryptionKey);
    await atomicJson(archive + '.json', manifest);
    await syncDirectory(dir);
    const secondary = process.env.SECONDARY_BACKUP_DIR;
    if (!secondary || secondary === dir) throw new Error('INDEPENDENT_BACKUP_DESTINATION_REQUIRED');
    await mkdir(secondary, { recursive: true, mode: 0o700 });
    await copyFile(archive, join(secondary, basename(archive)), constants.COPYFILE_EXCL);
    const copied = await import('node:fs/promises').then((fs) =>
      fs.open(join(secondary, basename(archive)), 'r+'),
    );
    try {
      await copied.sync();
    } finally {
      await copied.close();
    }
    if ((await fileHash(join(secondary, basename(archive)))) !== manifest.sha256)
      throw new Error('BACKUP_COPY_CHECKSUM_FAILED');
    await atomicJson(join(secondary, basename(archive) + '.json'), manifest);
    await syncDirectory(secondary);
    await atomicJson(join(dir, 'status.json'), {
      ok: true,
      lastSuccess: new Date().toISOString(),
      archive: basename(archive),
    });
    await syncDirectory(dir);
    const policy = await readPolicy();
    if (policy.approved && policy.backupRetentionDays) {
      for (const file of await readdir(dir))
        if (/^[0-9TZ-]+-[a-f0-9-]{36}\.gcm$/.test(file)) {
          const path = join(dir, file),
            meta = await stat(path);
          if (Date.now() - meta.mtimeMs > policy.backupRetentionDays * 86400000) {
            await unlink(path);
            await unlink(path + '.json').catch(() => {});
            await unlink(join(secondary, file)).catch((e) => {
              if (e.code !== 'ENOENT') throw e;
            });
            await unlink(join(secondary, file + '.json')).catch((e) => {
              if (e.code !== 'ENOENT') throw e;
            });
          }
        }
    }
    log('backup_completed', { archive: basename(archive) });
    return archive;
  } catch (e) {
    await atomicJson(join(dir, 'status.json'), {
      ok: false,
      lastFailure: new Date().toISOString(),
    });
    log('backup_failed');
    throw e;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function restore(archive, target) {
  if (
    !/^clinic_restore_[a-f0-9]{32}$/.test(target) &&
    !(process.env.ALLOW_DISPOSABLE_RESTORE === '1' && /^clinic_test_[a-f0-9]{32}$/.test(target))
  )
    throw new Error('FRESH_RESTORE_DATABASE_REQUIRED');
  const dir = process.env.BACKUP_DIR ?? '/backups',
    path = join(dir, basename(archive));
  if (basename(archive) !== archive || !/^[0-9TZ-]+-[a-f0-9-]{36}\.gcm$/.test(archive))
    throw new Error('ARCHIVE_BASENAME_REQUIRED');
  const manifest = JSON.parse(await readFile(path + '.json', 'utf8'));
  const encryptionKey = (await backupKey(manifest.keyVersion ?? 'legacy')).key;
  if (
    manifest.version !== 2 ||
    !verifyRecord('clinic:backup-manifest:v2', manifest, encryptionKey) ||
    manifest.sha256 !== (await fileHash(path))
  )
    throw new Error('ARCHIVE_CHECKSUM_FAILED');
  const ledger = await ledgerSnapshot();
  if (
    ledger.id !== manifest.ledgerId ||
    !Number.isInteger(manifest.ledgerCount) ||
    manifest.ledgerCount < 0 ||
    ledger.entries.length < manifest.ledgerCount ||
    prefixDigest(ledger, manifest.ledgerCount) !== manifest.ledgerPrefix
  )
    throw new Error('CURRENT_DELETION_LEDGER_REQUIRED');
  const temporary = await mkdtemp(join(tmpdir(), 'clinic-restore-'));
  const admin = await database('RESTORE_ADMIN_URL');
  let created = false;
  try {
    // Authenticate the COMPLETE archive before pg_restore sees any plaintext.
    await decryptFile(path, join(temporary, 'database.dump'), encryptionKey);
    await run('pg_restore', ['--list', join(temporary, 'database.dump')]);
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount)
      throw new Error('RESTORE_TARGET_EXISTS');
    await admin.query(`CREATE DATABASE ${identifier(target)} OWNER clinic_migrator`);
    created = true;
    await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(target)} FROM PUBLIC`);
    const url = new URL(await secret('RESTORE_ADMIN_URL'));
    url.pathname = '/' + target;
    const pg = await import('pg');
    await run(
      'pg_restore',
      [
        '--exit-on-error',
        '--dbname',
        target,
        '--no-owner',
        '--no-acl',
        '--role',
        'clinic_migrator',
        join(temporary, 'database.dump'),
      ],
      await pgEnvironment(url.toString()),
      {
        diagnosticFile:
          process.env.ALLOW_DISPOSABLE_RESTORE === '1'
            ? '/drill/pg-restore.private.stderr'
            : undefined,
      },
    );
    const db = new pg.default.Pool({ connectionString: url.toString(), max: 1 });
    try {
      await quarantineRestoredAccess(db);
      const restored = await checkIntegrity(db);
      if (
        restored.appointments !== manifest.integrity.appointments ||
        restored.consents !== manifest.integrity.consents
      )
        throw new Error('RESTORE_SNAPSHOT_COUNT_MISMATCH');
      await replayLedger(db);
      await checkIntegrity(db);
    } finally {
      await db.end();
    }
    const ledgerSigning = await ledgerKey();
    const receipt = {
      keyVersion: ledgerSigning.version,
      version: 1,
      target,
      source: manifest.integrity.database,
      archive,
      restoredAt: new Date().toISOString(),
      finalized: false,
    };
    receipt.mac = signRecord('clinic:restore-receipt:v1', receipt, ledgerSigning.key);
    await atomicJson(join(dir, 'restore-' + target + '.json'), receipt);
    await syncDirectory(dir);
    log('restore_completed', { target });
    return { target };
  } catch (e) {
    log('restore_failed', { targetCreated: created });
    throw e;
  } finally {
    await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function quarantineRestoredAccess(db) {
  await db.query('BEGIN');
  try {
    await db.query('DELETE FROM staff_sessions');
    await db.query(
      "UPDATE staff_users SET is_active=false,password_hash='RESTORE_QUARANTINED',mfa_enabled=false,mfa_secret_ciphertext=NULL,mfa_last_used_counter=NULL",
    );
    await db.query(
      "INSERT INTO audit_events(id,action,entity_type,request_id,metadata) VALUES($1,'RESTORE_ACCESS_QUARANTINED','system',$2,'{}')",
      [randomUUID(), randomUUID()],
    );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
export async function finalizeRestore(target) {
  if (process.env.DATABASE_CUTOVER_APPROVAL !== 'I_APPROVE_DATABASE_CUTOVER')
    throw new Error('EXPLICIT_DATABASE_CUTOVER_REQUIRED');
  if (
    !/^clinic_restore_[a-f0-9]{32}$/.test(target) &&
    !(process.env.ALLOW_DISPOSABLE_RESTORE === '1' && /^clinic_test_[a-f0-9]{32}$/.test(target))
  )
    throw new Error('FRESH_RESTORE_DATABASE_REQUIRED');
  return withRegistryLock(async () => {
    const dir = process.env.BACKUP_DIR ?? '/backups',
      path = join(dir, 'restore-' + target + '.json'),
      receipt = JSON.parse(await readFile(path, 'utf8'));
    if (
      !verifyRecord(
        'clinic:restore-receipt:v1',
        receipt,
        (await ledgerKey(receipt.keyVersion ?? 'legacy')).key,
      ) ||
      receipt.target !== target ||
      receipt.finalized ||
      receipt.source === target
    )
      throw new Error('VALID_RESTORE_RECEIPT_REQUIRED');
    const controlUrl = new URL(await secret('RESTORE_ADMIN_URL'));
    controlUrl.pathname = '/postgres';
    const pg = await import('pg'),
      control = new pg.default.Pool({ connectionString: controlUrl.toString(), max: 1 });
    let targetDb;
    try {
      if (
        (
          await control.query(
            "SELECT has_database_privilege('clinic_runtime',$1,'CONNECT') AS yes",
            [target],
          )
        ).rows[0].yes
      )
        throw new Error('RESTORE_TARGET_MUST_REMAIN_CLOSED');
      // Fence source BEFORE final snapshot. A stale erasure writer rechecks on source under this same lock.
      await control.query(`ALTER DATABASE ${identifier(receipt.source)} ALLOW_CONNECTIONS false`);
      await control.query(
        'SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [receipt.source],
      );
      if (
        (await control.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1', [receipt.source]))
          .rowCount
      )
        throw new Error('SOURCE_CONNECTIONS_NOT_FENCED');
      const url = new URL(await secret('RESTORE_ADMIN_URL'));
      url.pathname = '/' + target;
      targetDb = new pg.default.Pool({ connectionString: url.toString(), max: 1 });
      const ledger = await ledgerSnapshot();
      await replayLedger(targetDb, ledger);
      await quarantineRestoredAccess(targetDb);
      await checkIntegrity(targetDb);
      const { applyGrants } = await import('./database.mjs');
      const tx = await targetDb.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('SET LOCAL ROLE clinic_migrator');
        await applyGrants(tx);
        await tx.query('COMMIT');
      } catch (e) {
        await tx.query('ROLLBACK');
        throw e;
      } finally {
        tx.release();
      }
      Object.assign(receipt, {
        finalized: true,
        finalizedAt: new Date().toISOString(),
        ledgerCount: ledger.entries.length,
        ledgerPrefix: prefixDigest(ledger),
      });
      const activeLedgerKey = await ledgerKey();
      receipt.keyVersion = activeLedgerKey.version;
      receipt.mac = signRecord('clinic:restore-receipt:v1', receipt, activeLedgerKey.key);
      await atomicJson(path, receipt);
      await syncDirectory(dir);
      await control.query(
        `GRANT CONNECT ON DATABASE ${identifier(target)} TO clinic_runtime,clinic_operator,clinic_maintenance,clinic_backup,clinic_migrator`,
      );
      log('restore_finalized', { target, staffCredentialsQuarantined: true, sourceFenced: true });
      return { target };
    } catch (e) {
      await control
        .query(
          `REVOKE CONNECT ON DATABASE ${identifier(target)} FROM clinic_runtime,clinic_operator,clinic_maintenance,clinic_backup`,
        )
        .catch(() => {});
      throw e;
    } finally {
      if (targetDb) await targetDb.end();
      await control.end();
    }
  });
}
