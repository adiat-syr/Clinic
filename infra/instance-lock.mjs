import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export async function acquireInstanceLock(root) {
  const path = join(root, 'operation.lock');
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('INSTANCE_OPERATION_ALREADY_RUNNING');
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await file.sync();
  } finally {
    await file.close();
  }
  return () => unlink(path);
}
