import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ContactPrivacy, parsePrivacyEnvironment } from '../src/modules/booking/privacy.js';
describe('booking privacy boundary', () => {
  it('uses random envelopes and a stable server fingerprint', () => {
    const privacy = new ContactPrivacy({
      activeVersion: 'v1',
      keys: { v1: randomBytes(32) },
      hmacKey: randomBytes(32),
      timeZone: 'Asia/Almaty',
    });
    const data = { name: 'Синтетический посетитель', phone: '+70000000000' },
      a = privacy.sealContacts(data),
      b = privacy.sealContacts(data);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.patientNameCiphertext).not.toEqual(b.patientNameCiphertext);
    expect(privacy.open(a.patientNameCiphertext, 'v1', 'name')).toBe(data.name);
    expect(() => privacy.open(a.patientNameCiphertext, 'v1', 'phone')).toThrow(
      'CONTACTS_UNAVAILABLE',
    );
  });
  it('retains old-key reads and rejects unknown keys and tampering', () => {
    const old = randomBytes(32),
      hmacKey = randomBytes(32),
      first = new ContactPrivacy({
        activeVersion: 'v1',
        keys: { v1: old },
        hmacKey,
        timeZone: 'Asia/Almaty',
      }),
      a = first.sealContacts({ name: 'Синтетический посетитель', phone: '+70000000000' }),
      next = new ContactPrivacy({
        activeVersion: 'v2',
        keys: { v1: old, v2: randomBytes(32) },
        hmacKey,
        timeZone: 'Asia/Almaty',
      });
    expect(next.open(a.phoneCiphertext, 'v1', 'phone')).toBe('+70000000000');
    expect(() => next.open(a.phoneCiphertext, 'missing', 'phone')).toThrow();
    a.phoneCiphertext[a.phoneCiphertext.length - 1] =
      (a.phoneCiphertext[a.phoneCiphertext.length - 1] ?? 0) ^ 1;
    expect(() => next.open(a.phoneCiphertext, 'v1', 'phone')).toThrow();
  });
  it('fails closed on invalid/missing or reused keys without echoing values', () => {
    const k = randomBytes(32).toString('hex');
    const env = {
      AUTH_MFA_KEY: randomBytes(32).toString('hex'),
      AUTH_CSRF_KEY: randomBytes(32).toString('hex'),
      CONTACT_KEY_VERSION: 'v1',
      CONTACT_KEYS_JSON: JSON.stringify({ v1: k }),
      BOOKING_HMAC_KEY: randomBytes(32).toString('hex'),
      CLINIC_TIME_ZONE: 'Asia/Almaty',
    };
    expect(parsePrivacyEnvironment(env).activeVersion).toBe('v1');
    expect(() => parsePrivacyEnvironment({ ...env, BOOKING_HMAC_KEY: k })).toThrow();
    expect(() => parsePrivacyEnvironment({ ...env, CONTACT_KEYS_JSON: 'invalid' })).toThrow();
  });
});
