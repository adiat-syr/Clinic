import { z } from 'zod';
import { ConfigurationError } from '../../config/env.js';

const schema = z.object({
  AUTH_ORIGIN: z.url().refine((value) => {
    try {
      const u = new URL(value);
      return !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
    } catch {
      return false;
    }
  }),
  AUTH_MFA_KEY: z.string().regex(/^[0-9a-f]{64}$/),
  AUTH_CSRF_KEY: z.string().regex(/^[0-9a-f]{64}$/),
});
export interface SecurityConfig {
  origin: string;
  secureCookies: boolean;
  mfaKey: Uint8Array;
  csrfKey: Uint8Array;
  sessionCookie: string;
  csrfCookie: string;
}
export function parseSecurityEnvironment(env: NodeJS.ProcessEnv): SecurityConfig {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new ConfigurationError([
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  const url = new URL(result.data.AUTH_ORIGIN);
  if (
    url.protocol !== 'https:' &&
    (env.NODE_ENV === 'production' ||
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  ) {
    throw new ConfigurationError(['AUTH_ORIGIN']);
  }
  if (result.data.AUTH_MFA_KEY === result.data.AUTH_CSRF_KEY)
    throw new ConfigurationError(['AUTH_MFA_KEY', 'AUTH_CSRF_KEY']);
  const secureCookies = url.protocol === 'https:';
  return {
    origin: url.origin,
    secureCookies,
    mfaKey: Buffer.from(result.data.AUTH_MFA_KEY, 'hex'),
    csrfKey: Buffer.from(result.data.AUTH_CSRF_KEY, 'hex'),
    sessionCookie: secureCookies ? '__Host-clinic_session' : 'clinic_dev_session',
    csrfCookie: secureCookies ? '__Host-clinic_csrf' : 'clinic_dev_csrf',
  };
}
