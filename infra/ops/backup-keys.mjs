import { secret, key } from './lib.mjs';
export async function backupKey(version) {
  if (version === undefined && !process.env.BACKUP_KEYS_JSON_FILE && !process.env.BACKUP_KEYS_JSON)
    return { version: 'legacy', key: await key('BACKUP_KEY') };
  const selected = version ?? process.env.BACKUP_KEY_VERSION;
  if (selected === 'legacy') return { version: 'legacy', key: await key('BACKUP_KEY') };
  if (!/^[a-z0-9-]{1,40}$/.test(selected ?? '')) throw new Error('BACKUP_KEY_VERSION_REQUIRED');
  let values;
  try {
    values = JSON.parse(await secret('BACKUP_KEYS_JSON'));
  } catch {
    throw new Error('BACKUP_KEY_UNAVAILABLE');
  }
  if (
    !values ||
    Array.isArray(values) ||
    typeof values !== 'object' ||
    Object.entries(values).some(
      ([id, value]) =>
        !(
          /^[a-z0-9-]{1,40}$/.test(id) &&
          typeof value === 'string' &&
          /^[a-f0-9]{64}$/.test(value)
        ),
    ) ||
    !values[selected]
  )
    throw new Error('BACKUP_KEY_UNAVAILABLE');
  return { version: selected, key: Buffer.from(values[selected], 'hex') };
}
