import { readdir, lstat, chown } from 'node:fs/promises';
import { join } from 'node:path';
const uid = Number(process.env.APP_UID),
  gid = Number(process.env.APP_GID);
if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(gid) || gid < 1)
  throw new Error('Non-root UID/GID required');
async function set(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('Unexpected asset symlink');
  await chown(path, uid, gid);
  if (stat.isDirectory()) for (const name of await readdir(path)) await set(join(path, name));
}
await set('/app/apps/web/dist');
