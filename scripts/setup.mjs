import { randomBytes } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const env = new URL('.env', root);

try {
  const template = await readFile(new URL('.env.example', root), 'utf8');
  await writeFile(
    env,
    template
      .replaceAll('replace-me-local-only', randomBytes(24).toString('hex'))
      .replaceAll('replace-with-mfa-key', randomBytes(32).toString('hex'))
      .replaceAll('replace-with-csrf-key', randomBytes(32).toString('hex')),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created local .env for synthetic development. Credentials are not printed.');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    const existing = await readFile(env, 'utf8');
    const additions = [];
    if (!/^AUTH_ORIGIN=/m.test(existing)) additions.push('AUTH_ORIGIN=http://127.0.0.1:5173');
    if (!/^AUTH_MFA_KEY=/m.test(existing))
      additions.push(`AUTH_MFA_KEY=${randomBytes(32).toString('hex')}`);
    if (!/^AUTH_CSRF_KEY=/m.test(existing))
      additions.push(`AUTH_CSRF_KEY=${randomBytes(32).toString('hex')}`);
    if (additions.length) await appendFile(env, `\n${additions.join('\n')}\n`);
    console.log(
      'Existing values preserved; only missing security settings added. No keys printed.',
    );
  } else {
    throw error;
  }
}

const privacyEnv = await readFile(env, 'utf8');
const privacyAdd = [];
if (!/^CONTACT_KEY_VERSION=/m.test(privacyEnv)) privacyAdd.push('CONTACT_KEY_VERSION=local-v1');
if (!/^CONTACT_KEYS_JSON=/m.test(privacyEnv))
  privacyAdd.push(
    'CONTACT_KEYS_JSON=' + JSON.stringify({ 'local-v1': randomBytes(32).toString('hex') }),
  );
if (!/^BOOKING_HMAC_KEY=/m.test(privacyEnv))
  privacyAdd.push('BOOKING_HMAC_KEY=' + randomBytes(32).toString('hex'));
if (privacyAdd.length) await appendFile(env, '\n' + privacyAdd.join('\n') + '\n');
console.log(`Workspace: ${fileURLToPath(root)}`);
console.log('Next: npm run db:up, npm run db:deploy, npm run db:seed, npm run dev.');
