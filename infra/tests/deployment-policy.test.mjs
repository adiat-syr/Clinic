import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeployment, validateRollbackLabel } from '../deployment-policy.mjs';
import { acquireInstanceLock } from '../instance-lock.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('deployment and HTTPS fixture mutation cannot operate on the same instance concurrently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clinic-instance-lock-'));
  try {
    const release = await acquireInstanceLock(root);
    await assert.rejects(acquireInstanceLock(root), /INSTANCE_OPERATION_ALREADY_RUNNING/);
    await release();
    await (
      await acquireInstanceLock(root)
    )();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const v = {
  APP_UID: '1000',
  APP_GID: '1000',
  SITE_HOST: 'clinic.synthetic.kz',
  PUBLIC_ORIGIN: 'https://clinic.synthetic.kz',
  ACME_EMAIL: 'operator@synthetic.kz',
  HTTP_PORT: '80',
  HTTPS_PORT: '443',
  BACKUP_DIR: '/backup',
  SECONDARY_BACKUP_DIR: '/replica',
  LEDGER_DIR: '/ledger',
  LEDGER_CHECKPOINT_DIR: '/checkpoint',
};
test('production rejects placeholders, root, insecure origins and shared recovery paths', () => {
  assert.doesNotThrow(() => validateDeployment(v, 'production'));
  for (const patch of [
    { APP_UID: '0' },
    { SITE_HOST: 'SET-REAL-DOMAIN' },
    { PUBLIC_ORIGIN: 'http://clinic.synthetic.kz' },
    { ACME_EMAIL: 'operator@example.invalid' },
    { SECONDARY_BACKUP_DIR: '/backup' },
    { LEDGER_CHECKPOINT_DIR: '/ledger' },
  ])
    assert.throws(() => validateDeployment({ ...v, ...patch }, 'production'));
});
test('rollback rejects images without the durable privacy protocol', () => {
  assert.doesNotThrow(() => validateRollbackLabel('2', '2'));
  for (const labels of [
    ['', '2'],
    ['1', '2'],
    ['2', '1'],
  ])
    assert.throws(() => validateRollbackLabel(...labels));
});
