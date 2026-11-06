import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ConfigurationError } from '../../config/env.js';
import { AccessError } from '../security/errors.js';

export interface PrivacyConfig {
  activeVersion: string;
  keys: Record<string, Uint8Array>;
  hmacKey: Uint8Array;
  timeZone: string;
}
export function parsePrivacyEnvironment(env: NodeJS.ProcessEnv): PrivacyConfig {
  try {
    const activeVersion = z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .parse(env.CONTACT_KEY_VERSION);
    const values = z
      .record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.string().regex(/^[0-9a-f]{64}$/))
      .parse(JSON.parse(env.CONTACT_KEYS_JSON ?? ''));
    const hmac = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(env.BOOKING_HMAC_KEY);
    const mfaRing = env.AUTH_MFA_KEYS_JSON
      ? Object.values(
          z
            .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
            .parse(JSON.parse(env.AUTH_MFA_KEYS_JSON)),
        )
      : [];
    if (
      mfaRing.some(
        (k) => k === hmac || k === env.AUTH_CSRF_KEY || Object.values(values).includes(k),
      )
    )
      throw new Error();
    if (
      !values[activeVersion] ||
      new Set([...Object.values(values), hmac, env.AUTH_MFA_KEY, env.AUTH_CSRF_KEY]).size !==
        Object.values(values).length + 3
    )
      throw new Error();
    const timeZone = env.CLINIC_TIME_ZONE ?? '';
    new Intl.DateTimeFormat('en', { timeZone });
    return {
      activeVersion,
      keys: Object.fromEntries(Object.entries(values).map(([v, k]) => [v, Buffer.from(k, 'hex')])),
      hmacKey: Buffer.from(hmac, 'hex'),
      timeZone,
    };
  } catch {
    throw new ConfigurationError([
      'CONTACT_KEY_VERSION',
      'CONTACT_KEYS_JSON',
      'BOOKING_HMAC_KEY',
      'CLINIC_TIME_ZONE',
    ]);
  }
}
export const contactsSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[\p{L}\p{M} '-]+$/u),
  phone: z
    .string()
    .max(32)
    .transform((v) => v.replace(/[ ()-]/g, ''))
    .pipe(z.string().regex(/^\+7\d{10}$/)),
});
export class ContactPrivacy {
  constructor(readonly config: PrivacyConfig) {}
  private seal(value: string, purpose: string) {
    const version = this.config.activeVersion,
      key = this.config.keys[version];
    if (!key) throw new AccessError(503, 'CONTACTS_UNAVAILABLE');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`clinic:contact:${version}:${purpose}`));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
  }
  open(value: Uint8Array, version: string, purpose: 'name' | 'phone') {
    try {
      const key = this.config.keys[version];
      if (!key) throw new Error();
      const b = Buffer.from(value);
      if (b[0] !== 1 || b.length < 30) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13), { authTagLength: 16 });
      cipher.setAAD(Buffer.from(`clinic:contact:${version}:${purpose}`));
      cipher.setAuthTag(b.subarray(13, 29));
      return Buffer.concat([cipher.update(b.subarray(29)), cipher.final()]).toString('utf8');
    } catch {
      throw new AccessError(503, 'CONTACTS_UNAVAILABLE');
    }
  }
  sealContacts(input: z.infer<typeof contactsSchema>) {
    return {
      patientNameCiphertext: this.seal(input.name, 'name'),
      phoneCiphertext: this.seal(input.phone, 'phone'),
      encryptionKeyVersion: this.config.activeVersion,
      fingerprint: createHmac('sha256', this.config.hmacKey)
        .update(JSON.stringify(['contacts-v1', input.name, input.phone]))
        .digest('hex'),
    };
  }
}
