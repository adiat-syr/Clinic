import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { encryptFile, decryptFile, signRecord, verifyRecord, atomicJson } from '../ops/lib.mjs';
import {
  ledgerSnapshot,
  registerIntent,
  reconcileLedger,
  rotateLedgerKey,
  prefixDigest,
} from '../ops/ledger.mjs';

test('authenticated archive rejects corruption before exposing restore plaintext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clinic-crypto-'));
  try {
    const key = randomBytes(32),
      plain = join(dir, 'plain'),
      archive = join(dir, 'backup.gcm'),
      output = join(dir, 'restored');
    await writeFile(plain, 'synthetic-test-only');
    await encryptFile(plain, archive, key);
    await decryptFile(archive, output, key);
    assert.equal(await readFile(output, 'utf8'), 'synthetic-test-only');
    await rm(output);
    const bytes = await readFile(archive);
    bytes[30] ^= 1;
    await writeFile(archive, bytes);
    await assert.rejects(decryptFile(archive, output, key), /ARCHIVE_AUTHENTICATION_FAILED/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('signed manifest authenticates counts, ledger prefix and ciphertext digest', () => {
  const key = randomBytes(32),
    manifest = {
      version: 2,
      sha256: 'a'.repeat(64),
      integrity: { appointments: 2 },
      ledgerPrefix: 'b'.repeat(64),
    };
  manifest.mac = signRecord('clinic:backup-manifest:v2', manifest, key);
  assert.equal(verifyRecord('clinic:backup-manifest:v2', manifest, key), true);
  assert.equal(
    verifyRecord('clinic:backup-manifest:v2', { ...manifest, ledgerPrefix: 'c'.repeat(64) }, key),
    false,
  );
  assert.equal(verifyRecord('other-purpose', manifest, key), false);
  assert.equal(verifyRecord('clinic:backup-manifest:v2', manifest, randomBytes(32)), false);
});
test('erasure registry refuses missing/stale checkpoint, tampering and concurrent writers', async () => {
  const dir = await mkdtemp(resolve('.tmp/clinic-ledger-')),
    old = { ...process.env };
  try {
    process.env.DELETION_LEDGER_DIR = join(dir, 'primary');
    process.env.LEDGER_CHECKPOINT_DIR = join(dir, 'independent');
    process.env.DELETION_LEDGER_KEY = randomBytes(32).toString('hex');
    delete process.env.DELETION_LEDGER_KEY_FILE;
    process.env.NODE_ENV = 'test';
    const before = await ledgerSnapshot({ initialize: true });
    const stale = await readFile(join(process.env.LEDGER_CHECKPOINT_DIR, 'registry.json'));
    const id = randomUUID();
    await writeFile(
      join(process.env.DELETION_LEDGER_DIR, id + '.gcm'),
      'synthetic encrypted intent placeholder',
    );
    await registerIntent(id);
    assert.equal((await ledgerSnapshot()).entries.length, 1);
    const prefix = prefixDigest(await ledgerSnapshot());
    process.env.DELETION_LEDGER_KEYS_JSON = JSON.stringify({ v2: randomBytes(32).toString('hex') });
    process.env.DELETION_LEDGER_KEY_VERSION = 'v2';
    assert.deepEqual(await rotateLedgerKey(), { changed: true });
    assert.deepEqual(await rotateLedgerKey(), { changed: false });
    assert.equal(prefixDigest(await ledgerSnapshot()), prefix);

    await writeFile(join(process.env.LEDGER_CHECKPOINT_DIR, 'registry.json'), stale);
    await assert.rejects(ledgerSnapshot(), /LATEST_LEDGER_CHECKPOINT_MISMATCH/);
    await reconcileLedger();
    assert.equal((await ledgerSnapshot()).entries.length, 1);
    await writeFile(join(process.env.DELETION_LEDGER_DIR, 'registry.lock'), 'writer');
    await assert.rejects(reconcileLedger(), { code: 'EEXIST' });
    await rm(join(process.env.DELETION_LEDGER_DIR, 'registry.lock'));
    await rm(join(process.env.LEDGER_CHECKPOINT_DIR, 'registry.json'));
    await assert.rejects(ledgerSnapshot(), { code: 'ENOENT' });
    await reconcileLedger();
    assert.equal((await ledgerSnapshot()).id, before.id);
    const r = await ledgerSnapshot();
    r.entries = [];
    await atomicJson(join(process.env.DELETION_LEDGER_DIR, 'registry.json'), r);
    await assert.rejects(ledgerSnapshot(), /LEDGER_AUTHENTICATION_FAILED/);
    await copyFile(
      join(process.env.LEDGER_CHECKPOINT_DIR, 'registry.json'),
      join(process.env.DELETION_LEDGER_DIR, 'registry.json'),
    );
    await writeFile(join(process.env.DELETION_LEDGER_DIR, id + '.gcm'), 'tampered');
    await assert.rejects(ledgerSnapshot(), /LEDGER_ENTRY_MISSING_OR_CORRUPT/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
    await rm(dir, { recursive: true, force: true });
  }
});
