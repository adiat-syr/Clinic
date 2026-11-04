import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseEnvironment } from '../src/config/env.js';

const validEnvironment = {
  DATA_MODE: 'synthetic',
  DATABASE_URL: 'postgresql://synthetic:local_test_password@127.0.0.1:55432/clinic_test',
  CLINIC_TIME_ZONE: 'Asia/Almaty',
};

describe('environment boundary', () => {
  it('accepts synthetic configuration and defaults to loopback', () => {
    const config = parseEnvironment(validEnvironment);
    expect(config.API_HOST).toBe('127.0.0.1');
    expect(config.API_PORT).toBe(3001);
    expect(config.DATA_MODE).toBe('synthetic');
  });

  it.each(['0', '65536', 'invalid', '3001.5'])('rejects an invalid TCP port: %s', (API_PORT) => {
    expect(() => parseEnvironment({ ...validEnvironment, API_PORT })).toThrow(ConfigurationError);
  });

  it('rejects real-data mode rather than silently enabling it', () => {
    expect(() => parseEnvironment({ ...validEnvironment, DATA_MODE: 'production-data' })).toThrow(
      ConfigurationError,
    );
  });

  it('requires a supported IANA timezone', () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, CLINIC_TIME_ZONE: 'Invalid/Timezone' }),
    ).toThrow(ConfigurationError);
  });

  it('does not expose a malformed database URL or credentials in its error', () => {
    try {
      parseEnvironment({ ...validEnvironment, DATABASE_URL: 'private_password_not_a_url' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain('private_password');
    }
  });
});
