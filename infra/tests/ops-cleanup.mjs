import { readFile } from 'node:fs/promises';
import { database, identifier, log } from '../ops/lib.mjs';
const state = JSON.parse(await readFile('/drill/state.json', 'utf8'));
const db = await database('RESTORE_ADMIN_URL');
try {
  for (const target of [state.name, state.restoreName]) {
    if (!/^clinic_test_[a-f0-9]{32}$/.test(target)) throw new Error('OWNED_TEST_DATABASE_REQUIRED');
    await db.query(
      'SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [target],
    );
    await db.query(`DROP DATABASE IF EXISTS ${identifier(target)}`);
  }
  log('owned_ops_databases_cleaned');
} finally {
  await db.end();
}
