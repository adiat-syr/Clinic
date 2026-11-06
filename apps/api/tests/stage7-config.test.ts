import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';
import {
  demoProfile,
  loadClinicProfile,
  approvedConsentHash,
  publicBookingEnabled,
  phoneConsentEnabled,
} from '../src/config/clinic.js';
import { loadSecretFiles } from '../src/config/secrets.js';
import { sealMfa, openMfa } from '../src/modules/security/crypto.js';
import { parseSecurityEnvironment } from '../src/modules/security/config.js';

const dirs: string[] = [];
const file = (name: string, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'clinic-config-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('deployment configuration boundaries', () => {
  it('keeps public and manual booking closed while a clinic catalogue is being configured', () => {
    const env = {
      DATA_MODE: 'clinic',
      CLINIC_ACTIVATION_FILE: file('activation', {
        catalogueReviewed: false,
        phoneConsentApproved: false,
      }),
    };
    expect(publicBookingEnabled(env)).toBe(false);
    expect(phoneConsentEnabled(env)).toBe(false);
    expect(publicBookingEnabled({ ...env, CLINIC_ACTIVATION_FILE: 'missing-file' })).toBe(false);
    expect(publicBookingEnabled({ DATA_MODE: 'synthetic' })).toBe(true);
    expect(
      publicBookingEnabled({
        ...env,
        CLINIC_ACTIVATION_FILE: file('ready', { catalogueReviewed: true }),
      }),
    ).toBe(true);
  });
  it('loads only private server secret files', () => {
    const key = randomBytes(32).toString('hex'),
      env = { AUTH_MFA_KEY_FILE: file('key', key), IGNORED_FILE: 'does-not-exist' };
    loadSecretFiles(env);
    expect(env).toHaveProperty('AUTH_MFA_KEY', key);
    expect(env).not.toHaveProperty('IGNORED');
  });
  it('refuses ambiguous inline/file values without leaking either value', () => {
    const env = {
      AUTH_MFA_KEY: 'private-value',
      AUTH_MFA_KEY_FILE: file('key', 'another-private'),
    };
    expect(() => loadSecretFiles(env)).toThrow();
    try {
      loadSecretFiles(env);
    } catch (e) {
      expect(String(e)).not.toMatch(/private-value|another-private/);
    }
  });
  it('refuses a demo profile in clinic mode even with an approval artifact', () => {
    const env = {
      DATA_MODE: 'clinic',
      CLINIC_TIME_ZONE: 'Asia/Almaty',
      CLINIC_ACTIVATION_FILE: file('activation', {
        approved: true,
        clinicName: demoProfile.name.ru,
        decisionReference: 'synthetic-test',
        decidedAt: '2026-11-06T00:00:00Z',
        phoneConsentApproved: true,
        consentContentSha256: 'a'.repeat(64),
        catalogueReviewed: true,
      }),
    };
    expect(() => loadClinicProfile(env)).toThrow();
  });
  it('requires an explicit per-clinic activation and matching approved document hash', () => {
    const profile = {
      ...demoProfile,
      synthetic: false,
      name: { ru: 'Вымышленная клиника теста', kk: 'Сынақ клиникасы' },
      email: 'synthetic@example.test',
    };
    const env = {
      DATA_MODE: 'clinic',
      CLINIC_TIME_ZONE: 'Asia/Almaty',
      CLINIC_PROFILE_FILE: file('profile', profile),
    };
    expect(() => loadClinicProfile(env)).toThrow();
    const activated = {
      ...env,
      CLINIC_ACTIVATION_FILE: file('activation', {
        approved: true,
        clinicName: profile.name.ru,
        decisionReference: 'synthetic-test-only',
        decidedAt: '2026-11-06T00:00:00Z',
        phoneConsentApproved: false,
        consentContentSha256: 'a'.repeat(64),
        catalogueReviewed: true,
      }),
    };
    expect(loadClinicProfile(activated)).toEqual(profile);
    expect(approvedConsentHash(activated)).toBe('a'.repeat(64));
  });
  it('does not show a real profile under synthetic mode or a mismatching IANA zone', () => {
    expect(() =>
      loadClinicProfile({ DATA_MODE: 'synthetic', CLINIC_TIME_ZONE: 'Asia/Tokyo' }),
    ).toThrow();
    expect(() =>
      loadClinicProfile({
        DATA_MODE: 'synthetic',
        CLINIC_TIME_ZONE: 'Asia/Almaty',
        CLINIC_PROFILE_FILE: file('profile', { ...demoProfile, synthetic: false }),
      }),
    ).toThrow();
  });
  it('rejects a remote logo or embedded markup URL', () => {
    expect(() =>
      loadClinicProfile({
        DATA_MODE: 'synthetic',
        CLINIC_TIME_ZONE: 'Asia/Almaty',
        CLINIC_PROFILE_FILE: file('profile', {
          ...demoProfile,
          logoAsset: 'https://tracker.invalid/logo.svg',
        }),
      }),
    ).toThrow();
  });
});
describe('versioned MFA encryption', () => {
  it('rejects a deliberately constructed short GCM tag in a v2 factor envelope', () => {
    const id = 'v'.repeat(40),
      key = randomBytes(32),
      iv = randomBytes(12),
      user = 'synthetic-tag-check';
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 4 });
    cipher.setAAD(Buffer.from(`clinic:mfa:${user}:v2:${id}`));
    cipher.final();
    const envelope = Buffer.concat([
      Buffer.from([2, id.length]),
      Buffer.from(id),
      iv,
      cipher.getAuthTag(),
    ]);
    expect(() => openMfa(envelope, randomBytes(32), user, { [id]: key })).toThrow();
  });
  const secret = 'A'.repeat(32),
    user = 'synthetic-user',
    oldKey = randomBytes(32),
    nextKey = randomBytes(32);
  it('reads legacy factors and newly written factors using the selected ring key', () => {
    expect(openMfa(sealMfa(secret, oldKey, user), oldKey, user, { v2: nextKey })).toBe(secret);
    expect(openMfa(sealMfa(secret, nextKey, user, 'v2'), oldKey, user, { v2: nextKey })).toBe(
      secret,
    );
  });
  it('rejects missing keys, wrong subject binding and modified ciphertext', () => {
    const envelope = sealMfa(secret, nextKey, user, 'v2');
    expect(() => openMfa(envelope, oldKey, user, {})).toThrow();
    expect(() => openMfa(envelope, oldKey, 'other-user', { v2: nextKey })).toThrow();
    const changed = Buffer.from(envelope);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(() => openMfa(changed, oldKey, user, { v2: nextKey })).toThrow();
  });
  it('does not permit an active key absent from the ring or reuse of a CSRF key', () => {
    const csrf = randomBytes(32).toString('hex'),
      env = {
        AUTH_ORIGIN: 'https://clinic.example.test',
        AUTH_MFA_KEY: oldKey.toString('hex'),
        AUTH_CSRF_KEY: csrf,
        AUTH_MFA_ACTIVE_VERSION: 'v2',
        AUTH_MFA_KEYS_JSON: JSON.stringify({ v1: nextKey.toString('hex') }),
      };
    expect(() => parseSecurityEnvironment(env)).toThrow();
    expect(() =>
      parseSecurityEnvironment({ ...env, AUTH_MFA_KEYS_JSON: JSON.stringify({ v2: csrf }) }),
    ).toThrow();
  });
});
