import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  database,
  readFile,
  atomicJson,
  signRecord,
  verifyRecord,
  syncDirectory,
  log,
} from './lib.mjs';
import { ledgerKey } from './ledger-keys.mjs';
import { ledgerSnapshot, prefixDigest, withRegistryLock } from './ledger.mjs';
import { replayLedger } from './maintenance.mjs';
export async function reconcilePrivacy() {
  return withRegistryLock(async () => {
    const db = await database();
    try {
      const identity = (
        await db.query(
          'SELECT current_database() AS name,oid::text FROM pg_database WHERE datname=current_database()',
        )
      ).rows[0];
      const registry = await ledgerSnapshot(),
        path = join(
          process.env.DELETION_LEDGER_DIR,
          'applied-' +
            createHash('sha256').update(JSON.stringify(identity)).digest('hex') +
            '.json',
        );
      let count = 0;
      try {
        const cursor = JSON.parse(await readFile(path, 'utf8'));
        if (
          !verifyRecord(
            'clinic:privacy-cursor:v1',
            cursor,
            (await ledgerKey(cursor.keyVersion ?? 'legacy')).key,
          ) ||
          cursor.ledgerId !== registry.id ||
          cursor.identity?.name !== identity.name ||
          cursor.identity?.oid !== identity.oid ||
          !Number.isInteger(cursor.count) ||
          cursor.count < 0 ||
          cursor.count > registry.entries.length ||
          cursor.prefix !== prefixDigest(registry, cursor.count)
        )
          throw new Error('INVALID_PRIVACY_CURSOR');
        count = cursor.count;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const applied =
        count < registry.entries.length
          ? await replayLedger(db, { ...registry, entries: registry.entries.slice(count) })
          : 0;
      const active = await ledgerKey(),
        cursor = {
          identity,
          keyVersion: active.version,
          ledgerId: registry.id,
          count: registry.entries.length,
          prefix: prefixDigest(registry),
        };
      cursor.mac = signRecord('clinic:privacy-cursor:v1', cursor, active.key);
      await atomicJson(path, cursor);
      await syncDirectory(process.env.DELETION_LEDGER_DIR);
      log('privacy_reconciled', { applied });
      return { applied };
    } finally {
      await db.end();
    }
  });
}
