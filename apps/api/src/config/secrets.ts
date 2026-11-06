import { readFileSync, statSync } from 'node:fs';
import { ConfigurationError } from './env.js';

const secretNames = [
  'DATABASE_URL',
  'AUTH_MFA_KEY',
  'AUTH_MFA_KEYS_JSON',
  'AUTH_CSRF_KEY',
  'CONTACT_KEYS_JSON',
  'BOOKING_HMAC_KEY',
] as const;
// Docker secrets/host secret mounts; values never enter argv, public config or logs.
export function loadSecretFiles(env: NodeJS.ProcessEnv = process.env) {
  for (const name of secretNames) {
    const path = env[name + '_FILE'];
    if (!path) continue;
    if (env[name]) throw new ConfigurationError([name]);
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size < 1 || info.size > 65536) throw new Error();
      const value = readFileSync(path, 'utf8').trim();
      if (!value) throw new Error();
      env[name] = value;
    } catch {
      throw new ConfigurationError([name + '_FILE']);
    }
  }
}
