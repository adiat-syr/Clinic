import { ledgerKey } from './ledger-keys.mjs';
import { join, resolve } from 'node:path';
import { open, stat, copyFile, constants, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  atomicJson,
  mkdir,
  fileHash,
  signRecord,
  verifyRecord,
  syncDirectory,
  canonical,
} from './lib.mjs';
const purpose = 'clinic:deletion-registry:v1';
function paths() {
  const dir = process.env.DELETION_LEDGER_DIR,
    mirror = process.env.LEDGER_CHECKPOINT_DIR;
  if (!dir || !mirror || resolve(dir) === resolve(mirror))
    throw new Error('INDEPENDENT_LEDGER_CHECKPOINT_REQUIRED');
  return { dir, mirror };
}
async function readRegistry(dir) {
  const r = JSON.parse(await readFile(join(dir, 'registry.json'), 'utf8'));
  const encryptionKey = (await ledgerKey(r.keyVersion ?? 'legacy')).key;
  if (
    r.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(r.id) ||
    !Array.isArray(r.entries) ||
    (r.revision !== undefined &&
      (!Number.isSafeInteger(r.revision) || r.revision < r.entries.length)) ||
    !verifyRecord(purpose, r, encryptionKey)
  )
    throw new Error('LEDGER_AUTHENTICATION_FAILED');
  const ids = new Set();
  for (const e of r.entries) {
    await ledgerKey(e.keyVersion ?? 'legacy');
    if (
      !/^[a-f0-9-]{36}$/.test(e.id) ||
      !/^[a-f0-9]{64}$/.test(e.sha256) ||
      ids.has(e.id) ||
      e.sha256 !== (await fileHash(join(dir, e.id + '.gcm')))
    )
      throw new Error('LEDGER_ENTRY_MISSING_OR_CORRUPT');
    ids.add(e.id);
  }
  return r;
}
export function prefixDigest(registry, count = registry.entries.length) {
  return createHash('sha256')
    .update(canonical(registry.entries.slice(0, count)))
    .digest('hex');
}
async function snapshotUnlocked({ initialize = false } = {}) {
  const { dir, mirror } = paths();
  let a, b;
  try {
    a = await readRegistry(dir);
  } catch (e) {
    if (e.code !== 'ENOENT' || !initialize) throw e;
  }
  try {
    b = await readRegistry(mirror);
  } catch (e) {
    if (e.code !== 'ENOENT' || !initialize) throw e;
  }
  if (!a && !b && initialize) {
    const selected = await ledgerKey(),
      encryptionKey = selected.key;
    const r = {
      version: 1,
      id: randomUUID(),
      entries: [],
      keyVersion: selected.version,
      revision: 0,
    };
    r.mac = signRecord(purpose, r, encryptionKey);
    for (const root of [dir, mirror]) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await atomicJson(join(root, 'registry.json'), r);
      await syncDirectory(root);
    }
    return r;
  }
  if (!a || !b || a.id !== b.id || canonical(a) !== canonical(b))
    throw new Error('LATEST_LEDGER_CHECKPOINT_MISMATCH');
  return a;
}
async function registerUnlocked(id, version) {
  const { dir, mirror } = paths();
  const r = await ledgerSnapshot();
  const digest = await fileHash(join(dir, id + '.gcm'));
  await copyFile(join(dir, id + '.gcm'), join(mirror, id + '.gcm'), constants.COPYFILE_EXCL);
  const f = await open(join(mirror, id + '.gcm'), 'r+');
  try {
    await f.sync();
  } finally {
    await f.close();
  }
  r.entries.push({ id, sha256: digest, keyVersion: version ?? (await ledgerKey()).version });
  const active = await ledgerKey();
  r.keyVersion = active.version;
  r.revision = (r.revision ?? r.entries.length - 1) + 1;
  r.mac = signRecord(purpose, r, active.key);
  for (const root of [dir, mirror]) {
    await atomicJson(join(root, 'registry.json'), r);
    await syncDirectory(root);
  }
}
export async function registerIntent(id, { locked = false, version } = {}) {
  return locked
    ? registerUnlocked(id, version)
    : withRegistryLock(() => registerUnlocked(id, version));
}

async function reconcileUnlocked() {
  const { dir, mirror } = paths();
  let a, b;
  try {
    a = await readRegistry(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    b = await readRegistry(mirror);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!a && !b) throw new Error('NO_AUTHENTICATED_LEDGER');
  if (
    a &&
    b &&
    (a.id !== b.id ||
      ((a.revision ?? a.entries.length) === (b.revision ?? b.entries.length) &&
        canonical(a) !== canonical(b)) ||
      prefixDigest(a, Math.min(a.entries.length, b.entries.length)) !==
        prefixDigest(b, Math.min(a.entries.length, b.entries.length)))
  )
    throw new Error('LEDGER_FORK');
  const chosen = !a
      ? b
      : !b
        ? a
        : (a.revision ?? a.entries.length) >= (b.revision ?? b.entries.length)
          ? a
          : b,
    source = chosen === a ? dir : mirror;
  for (const target of [dir, mirror]) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (target !== source)
      for (const e of chosen.entries) {
        try {
          await copyFile(
            join(source, e.id + '.gcm'),
            join(target, e.id + '.gcm'),
            constants.COPYFILE_EXCL,
          );
          const copied = await open(join(target, e.id + '.gcm'), 'r+');
          try {
            await copied.sync();
          } finally {
            await copied.close();
          }
        } catch (err) {
          if (err.code !== 'EEXIST' || (await fileHash(join(target, e.id + '.gcm'))) !== e.sha256)
            throw err;
        }
      }
    await atomicJson(join(target, 'registry.json'), chosen);
    await syncDirectory(target);
  }
  return { entries: chosen.entries.length };
}
export async function ledgerHealth() {
  const r = await ledgerSnapshot();
  return {
    id: r.id,
    count: r.entries.length,
    modifiedAt: (await stat(join(paths().dir, 'registry.json'))).mtime.toISOString(),
  };
}

export async function withRegistryLock(work) {
  const { dir } = paths();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await open(join(dir, 'registry.lock'), 'wx', 0o600);
  try {
    return await work();
  } finally {
    await lock.close();
    await unlink(join(dir, 'registry.lock'));
  }
}
export async function ledgerSnapshot(options = {}) {
  return options.initialize
    ? withRegistryLock(() => snapshotUnlocked(options))
    : snapshotUnlocked(options);
}

export async function reconcileLedger() {
  return withRegistryLock(reconcileUnlocked);
}

export async function rotateLedgerKey() {
  return withRegistryLock(async () => {
    const r = await ledgerSnapshot(),
      active = await ledgerKey();
    for (const entry of r.entries) await ledgerKey(entry.keyVersion ?? 'legacy');
    if (r.keyVersion === active.version) return { changed: false };
    r.keyVersion = active.version;
    r.revision = (r.revision ?? r.entries.length) + 1;
    r.mac = signRecord(purpose, r, active.key);
    for (const dir of Object.values(paths())) {
      await atomicJson(join(dir, 'registry.json'), r);
      await syncDirectory(dir);
    }
    return { changed: true };
  });
}
