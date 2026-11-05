import type { Transaction } from '../booking/transaction.js';

export async function lockStaffManagement(tx: Transaction) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(75003,1)`;
}
export async function lockStaff(tx: Transaction, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw`SELECT id FROM staff_users WHERE id=${id}::uuid FOR UPDATE`;
}
export function writeAudit(
  tx: Transaction,
  action: string,
  entityType: string,
  entityId: string | null,
  requestId: string,
  actorUserId: string | null,
  fields: string[] = [],
) {
  return tx.auditEvent.create({
    data: {
      action,
      entityType,
      entityId,
      requestId,
      actorUserId,
      metadata: fields.length ? { fields } : {},
    },
  });
}
