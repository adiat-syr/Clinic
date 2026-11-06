import { secret, key } from './lib.mjs';
export async function ledgerKey(version) {
  const selected = version ?? process.env.DELETION_LEDGER_KEY_VERSION ?? 'legacy';
  if (selected === 'legacy') return { version: 'legacy', key: await key('DELETION_LEDGER_KEY') };
  if (!/^[a-z0-9-]{1,40}$/.test(selected)) throw new Error('LEDGER_KEY_VERSION_REQUIRED');
  let values;
  try {
    values = JSON.parse(await secret('DELETION_LEDGER_KEYS_JSON'));
  } catch {
    throw new Error('LEDGER_KEY_UNAVAILABLE');
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
    throw new Error('LEDGER_KEY_UNAVAILABLE');
  return { version: selected, key: Buffer.from(values[selected], 'hex') };
}
