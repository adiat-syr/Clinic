import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parseSecurityEnvironment } from '../src/modules/security/config.js';
import { ConfigurationError } from '../src/config/env.js';
import { sealMfa, openMfa } from '../src/modules/security/crypto.js';

const env = {
  NODE_ENV: 'test',
  AUTH_ORIGIN: 'https://clinic.example.test',
  AUTH_MFA_KEY: randomBytes(32).toString('hex'),
  AUTH_CSRF_KEY: randomBytes(32).toString('hex'),
};
describe('security configuration and key boundaries', () => {
  it('requires independent keys and HTTPS in production', () => {
    expect(() => parseSecurityEnvironment({ ...env, AUTH_MFA_KEY: env.AUTH_CSRF_KEY })).toThrow(
      ConfigurationError,
    );
    expect(() => parseSecurityEnvironment({ ...env, AUTH_MFA_KEY: '' })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      parseSecurityEnvironment({
        ...env,
        NODE_ENV: 'production',
        AUTH_ORIGIN: 'http://127.0.0.1:5173',
      }),
    ).toThrow(ConfigurationError);
    expect(
      parseSecurityEnvironment({
        ...env,
        NODE_ENV: 'development',
        AUTH_ORIGIN: 'http://127.0.0.1:5173',
      }).secureCookies,
    ).toBe(false);
  });
  it.each([
    'invalid-secret-url',
    'https://user:password@clinic.example.test',
    'https://clinic.example.test/path',
    'http://public.example.test',
  ])('rejects an unsafe origin without echoing its value', (origin) => {
    try {
      parseSecurityEnvironment({ ...env, AUTH_ORIGIN: origin });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(origin);
    }
  });
  it('binds encrypted MFA material to the staff id and detects modification', () => {
    const key = randomBytes(32),
      id = randomUUID(),
      secret = randomBytes(20).toString('hex');
    const sealed = sealMfa(secret, key, id);
    expect(openMfa(sealed, key, id)).toBe(secret);
    expect(() => openMfa(sealed, key, randomUUID())).toThrow('MFA_UNAVAILABLE');
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openMfa(tampered, key, id)).toThrow('MFA_UNAVAILABLE');
  });
});
