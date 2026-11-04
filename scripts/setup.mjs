import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const env = new URL('.env', root);

try {
  const template = await readFile(new URL('.env.example', root), 'utf8');
  await writeFile(
    env,
    template.replaceAll('replace-me-local-only', randomBytes(24).toString('hex')),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created local .env for synthetic development. Credentials are not printed.');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    console.log('Existing .env preserved.');
  } else {
    throw error;
  }
}

console.log(`Workspace: ${fileURLToPath(root)}`);
console.log('Next: npm run db:up, npm run db:deploy, npm run db:seed, npm run dev.');
