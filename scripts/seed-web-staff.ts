import { randomUUID } from 'node:crypto';
import { createPrisma } from '../apps/api/src/infrastructure/prisma.js';
import { AuthService } from '../apps/api/src/modules/security/service.js';
import { parseSecurityEnvironment } from '../apps/api/src/modules/security/config.js';
import { totpCounter } from '../apps/api/src/modules/security/crypto.js';
import * as OTPAuth from 'otpauth';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  !/^\/clinic_test_[a-f0-9]{32}$/.test(new URL(url).pathname)
)
  throw new Error('Owned temporary DB required');
const password = process.env.WEB_STAFF_PASSWORD,
  secret = process.env.WEB_STAFF_MFA;
if (!password || !secret) throw new Error('Ephemeral test credentials required');
const client = createPrisma(url);
try {
  const auth = new AuthService(client, parseSecurityEnvironment(process.env));
  await auth.ready();
  const code = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate();
  if (totpCounter(secret, code, new Date()) === null) throw new Error();
  await auth.bootstrap({ email: 'web-admin@example.invalid', password, mfaSecret: secret, code });
  await client.staffUser.create({
    data: {
      id: randomUUID(),
      email: 'web-reception@example.invalid',
      role: 'RECEPTIONIST',
      isActive: false,
      passwordHash: 'DISABLED',
    },
  });
  await auth.provisionCredentials({
    email: 'web-reception@example.invalid',
    password,
    mfaSecret: secret,
    code,
  });
  console.log('Ephemeral staff provisioned only in owned browser-test DB; no credentials printed.');
} finally {
  await client.$disconnect();
}
