// Real Linux pseudoterminal; generated values never reach runner output or argv.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { createPrisma } from '../../apps/api/dist/infrastructure/prisma.js';
const state = JSON.parse(await readFile('/drill/state.json', 'utf8'));
if (!/^clinic_test_[a-f0-9]{32}$/.test(state.name)) throw new Error('OWNED_TEST_DATABASE_REQUIRED');
const url = (await readFile('/drill/operator_database_url', 'utf8')).trim();
assert.equal(new URL(url).pathname, '/' + state.name);
const db = createPrisma(url),
  email = 'synthetic-tty-' + randomUUID() + '@example.invalid',
  password = randomBytes(32).toString('base64url'),
  mfa = new OTPAuth.Secret({ size: 20 }).base32;
const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(mfa), digits: 6, period: 30 });
try {
  await db.staffUser.create({ data: { email, passwordHash: 'DISABLED', role: 'RECEPTIONIST' } });
  let transcript = '',
    index = 0;
  const prompts = [
    'Staff email: ',
    'New unique password (16–128 characters): ',
    'Repeat password: ',
    'Offline TOTP key (base32, at least 32 characters): ',
    'Current 6-digit TOTP code: ',
  ];
  const values = [email, password, password, mfa, () => totp.generate()];
  await new Promise((ok, bad) => {
    const child = spawn(
      'script',
      ['-q', '-e', '-c', 'node infra/ops/cli.mjs staff credentials', '/dev/null'],
      {
        env: { ...process.env, DATABASE_URL_FILE: '/drill/operator_database_url' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      bad(new Error('TTY_DRIVER_TIMEOUT'));
    }, 30000);
    child.on('error', bad);
    child.stdout.on('data', (b) => {
      transcript += b;
      if (index < prompts.length && transcript.includes(prompts[index])) {
        const value = values[index++];
        setTimeout(
          () => child.stdin.write((typeof value === 'function' ? value() : value) + '\n'),
          80,
        );
      }
    });
    child.stderr.on('data', (b) => {
      transcript += b;
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) ok();
      else bad(new Error('PRIVATE_TTY_PROCEDURE_FAILED'));
    });
  });
  assert.equal(index, 5);
  assert.ok(transcript.includes('Credentials provisioned and audited.'));
  for (const value of [email, password, mfa])
    assert.equal(transcript.includes(value), false, 'Private input echoed by CLI');
  const staff = await db.staffUser.findUniqueOrThrow({ where: { email } });
  assert.equal(staff.role, 'RECEPTIONIST');
  assert.equal(staff.mfaEnabled, true);
  assert.ok(staff.passwordHash.startsWith('$argon2id$'));
  console.log(
    JSON.stringify({
      event: 'linux_private_tty_verified',
      inputNotEchoed: true,
      rolePreserved: true,
    }),
  );
} finally {
  await db.$disconnect();
}
