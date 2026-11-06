import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRegistryLock, registerIntent, ledgerSnapshot } from './ledger.mjs';
import { ledgerKey } from './ledger-keys.mjs';
import { atomicJson, encryptFile } from './lib.mjs';
const held = new AsyncLocalStorage();
export async function verifyWithdrawalJournal() {
  await ledgerSnapshot();
}
export function createWithdrawalJournal() {
  return {
    withLock: (work) => withRegistryLock(() => held.run(true, work)),
    async record(input) {
      if (!held.getStore()) throw new Error('WITHDRAWAL_LOCK_REQUIRED');
      if (
        !/^[a-f0-9-]{36}$/.test(input.appointmentId) ||
        !/^[a-f0-9-]{36}$/.test(input.documentId) ||
        !/^[a-f0-9-]{36}$/.test(input.operationId) ||
        !Number.isFinite(Date.parse(input.withdrawnAt)) ||
        !/^[a-f0-9-]{36}$/.test(input.actorId) ||
        !/^[a-f0-9-]{36}$/.test(input.requestId)
      )
        throw new Error('INVALID_WITHDRAWAL_INTENT');
      const temporary = await mkdtemp(join(tmpdir(), 'clinic-withdrawal-')),
        selected = await ledgerKey();
      try {
        await atomicJson(join(temporary, 'intent.json'), {
          version: 1,
          type: 'WITHDRAWAL',
          appointmentId: input.appointmentId,
          documentId: input.documentId,
          operationId: input.operationId,
          withdrawnAt: input.withdrawnAt,
          actorId: input.actorId,
          requestId: input.requestId,
        });
        await encryptFile(
          join(temporary, 'intent.json'),
          join(process.env.DELETION_LEDGER_DIR, input.operationId + '.gcm'),
          selected.key,
        );
        await registerIntent(input.operationId, { locked: true, version: selected.version });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}
