import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';

export async function secret(name, env = process.env) {
  if (env[name + '_FILE']) {
    if (env[name]) throw new Error('AMBIGUOUS_SECRET');
    return (await readFile(env[name + '_FILE'], 'utf8')).trim();
  }
  if (env.NODE_ENV === 'production') throw new Error('SECRET_FILE_REQUIRED');
  if (!env[name]) throw new Error('SECRET_REQUIRED');
  return env[name];
}
export async function database(name = 'DATABASE_URL') {
  const pool = new pg.Pool({
    connectionString: await secret(name),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
  });
  pool.on('error', () => log('database_pool_error'));
  return pool;
}
export function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
export function setting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error('INVALID_OPERATIONAL_CONFIGURATION');
  return value;
}
export async function run(
  command,
  args,
  env = process.env,
  { inherit = false, diagnosticFile } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    if (!inherit) {
      child.stdout.on('data', (b) => {
        if (output.length < 1048576) output += b;
      });
      child.stderr.on('data', (b) => {
        if (errors.length < 65536) errors += b;
      });
    }
    child.on('error', () => reject(new Error('SUBPROCESS_UNAVAILABLE')));
    child.on('exit', async (code) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      if (diagnosticFile && process.env.ALLOW_DISPOSABLE_RESTORE === '1')
        await writeFile(diagnosticFile, errors, { mode: 0o600 }).catch(() => {});
      // Enumerated diagnostics only: PostgreSQL stderr can contain contacts/SQL literals.
      const reason = /schema .* already exists/i.test(errors)
        ? 'SCHEMA_EXISTS'
        : /permission denied/i.test(errors)
          ? 'PERMISSION_DENIED'
          : /must be owner/i.test(errors)
            ? 'OWNER_REQUIRED'
            : /extension.*not available/i.test(errors)
              ? 'EXTENSION_UNAVAILABLE'
              : /no space left/i.test(errors)
                ? 'STORAGE_FULL'
                : 'SUBPROCESS_FAILED';
      log('subprocess_failed', { reason });
      reject(new Error(reason));
    });
  });
}
export async function pgEnvironment(url) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '10',
  };
}
export function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('INVALID_IDENTIFIER');
  return '"' + value + '"';
}
export async function atomicJson(path, value) {
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  const f = await open(temporary, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(value) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temporary, path);
}
export async function key(name) {
  const value = await secret(name);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('INVALID_ENCRYPTION_KEY');
  return Buffer.from(value, 'hex');
}
const magic = Buffer.from('CLINICBK2');
export async function encryptFile(source, target, encryptionKey) {
  const iv = randomBytes(12),
    header = Buffer.concat([magic, iv]),
    cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(header);
  const f = await open(target, 'wx', 0o600);
  try {
    await f.write(header);
  } finally {
    await f.close();
  }
  try {
    await pipeline(
      createReadStream(source),
      cipher,
      createWriteStream(target, { flags: 'a', mode: 0o600 }),
    );
    const f = await open(target, 'a');
    try {
      await f.write(cipher.getAuthTag());
      await f.sync();
    } finally {
      await f.close();
    }
  } catch (e) {
    await unlink(target).catch(() => {});
    throw e;
  }
}
export async function decryptFile(source, target, encryptionKey) {
  const f = await open(source, 'r');
  let size, header, tag;
  try {
    size = (await f.stat()).size;
    if (size < magic.length + 28) throw new Error('INVALID_ARCHIVE');
    header = Buffer.alloc(magic.length + 12);
    tag = Buffer.alloc(16);
    await f.read(header, 0, header.length, 0);
    await f.read(tag, 0, 16, size - 16);
  } finally {
    await f.close();
  }
  if (!header.subarray(0, magic.length).equals(magic)) throw new Error('INVALID_ARCHIVE');
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey, header.subarray(magic.length), {
    authTagLength: 16,
  });
  cipher.setAAD(header);
  cipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: header.length, end: size - 17 }),
      cipher,
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
    );
  } catch {
    await unlink(target).catch(() => {});
    throw new Error('ARCHIVE_AUTHENTICATION_FAILED');
  }
}
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function signRecord(purpose, record, encryptionKey) {
  const body = { ...record };
  delete body.mac;
  return createHmac('sha256', encryptionKey)
    .update(purpose + '\n' + canonical(body))
    .digest('hex');
}
export function verifyRecord(purpose, record, encryptionKey) {
  return (
    /^[a-f0-9]{64}$/.test(record.mac ?? '') &&
    timingSafeEqual(
      Buffer.from(record.mac, 'hex'),
      Buffer.from(signRecord(purpose, record, encryptionKey), 'hex'),
    )
  );
}
export async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export { readFile, writeFile, mkdir, unlink, randomBytes };
