import { mkdir, lstat, chown } from 'node:fs/promises';

// Railway mounts volumes as root. Change only the dedicated mount owner, then
// drop privileges before reading secrets, connecting to PG or starting HTTP.
const root = process.env.DEMO_STATE_DIR ?? '/data';
if (root !== '/data') throw new Error('Dedicated /data mount required');
if (process.getuid?.() === 0) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid state mount');
  await chown(root, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
await import('./start.mjs');
