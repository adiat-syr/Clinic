import {
  createHash,
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import * as argon2 from 'argon2';
import * as OTPAuth from 'otpauth';
import { AccessError } from './errors.js';

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const mac = (key: Uint8Array, purpose: string, value: string) =>
  createHmac('sha256', key)
    .update(JSON.stringify([purpose, value]))
    .digest('hex');
export function equalMac(a: string, b: string) {
  return (
    /^[0-9a-f]{64}$/.test(a) &&
    /^[0-9a-f]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}
let passwordWorkers = 0;
async function passwordBudget<T>(work: () => Promise<T>) {
  if (passwordWorkers >= 4) throw new AccessError(429, 'AUTH_BUSY');
  passwordWorkers++;
  try {
    return await work();
  } finally {
    passwordWorkers--;
  }
}
export function hashPassword(password: string) {
  return passwordBudget(() =>
    argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    }),
  );
}
export async function verifyPassword(hash: string, password: string) {
  try {
    return await passwordBudget(() => argon2.verify(hash, password));
  } catch (error) {
    if (error instanceof AccessError) throw error;
    return false;
  }
}
export function sealMfa(secret: string, key: Uint8Array, userId: string, keyId?: string) {
  if (keyId && !/^[a-z0-9-]{1,40}$/.test(keyId)) throw new Error('Invalid key id');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(
    Buffer.from(keyId ? `clinic:mfa:${userId}:v2:${keyId}` : `clinic:mfa:${userId}:v1`),
  );
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([
    keyId ? Buffer.concat([Buffer.from([2, keyId.length]), Buffer.from(keyId)]) : Buffer.from([1]),
    nonce,
    cipher.getAuthTag(),
    body,
  ]);
}
export function openMfa(
  envelope: Uint8Array,
  key: Uint8Array,
  userId: string,
  keys: Record<string, Uint8Array> = {},
) {
  try {
    const buffer = Buffer.from(envelope);
    if (buffer.length < 30 || ![1, 2].includes(buffer[0] ?? 0)) throw new Error();
    const keyId =
      buffer[0] === 2 ? buffer.subarray(2, 2 + (buffer[1] ?? 0)).toString('utf8') : null;
    const offset = keyId ? 2 + Buffer.byteLength(keyId) : 1;
    if (buffer.length < offset + 29) throw new Error();
    if (keyId && (!/^[a-z0-9-]{1,40}$/.test(keyId) || !keys[keyId])) throw new Error();
    if (buffer[0] === 2 && !keyId) throw new Error();
    const cipher = createDecipheriv(
      'aes-256-gcm',
      keyId ? (keys[keyId] ?? key) : key,
      buffer.subarray(offset, offset + 12),
      { authTagLength: 16 },
    );
    cipher.setAAD(
      Buffer.from(keyId ? `clinic:mfa:${userId}:v2:${keyId}` : `clinic:mfa:${userId}:v1`),
    );
    cipher.setAuthTag(buffer.subarray(offset + 12, offset + 28));
    return Buffer.concat([cipher.update(buffer.subarray(offset + 28)), cipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new AccessError(503, 'MFA_UNAVAILABLE');
  }
}
export function totpCounter(secret: string, code: string, now: Date): bigint | null {
  try {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    const delta = totp.validate({ token: code, timestamp: now.getTime(), window: 1 });
    return delta === null ? null : BigInt(Math.floor(now.getTime() / 30000) + delta);
  } catch {
    return null;
  }
}
