import { readFile, cp, readdir, rename, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const source = '/opt/clinic-web',
  target = '/app/apps/web/dist';
// Hashed assets are immutable. Retain previous hashes for already open pages.
await mkdir(join(target, 'assets'), { recursive: true });
await cp(join(source, 'assets'), join(target, 'assets'), { recursive: true, force: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith('.html')) continue;
  const temporary = join(target, entry.name + '.next');
  await copyFile(join(source, entry.name), temporary);
  await rename(temporary, join(target, entry.name));
}
await copyFile(join(source, 'prerender-template.html'), join(target, 'prerender-template.html'));
if (process.env.DATABASE_URL_FILE)
  process.env.DATABASE_URL = (await readFile(process.env.DATABASE_URL_FILE, 'utf8')).trim();
await import('../../apps/web/scripts/prerender.mjs');
