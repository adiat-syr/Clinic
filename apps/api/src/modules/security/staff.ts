import { randomBytes } from 'node:crypto';
import type { Transaction } from '../booking/transaction.js';
import { validated, AccessError } from './errors.js';
import { writeAudit } from './repository.js';
import { paginationSchema, staffCreateSchema, staffPatchSchema, uuidSchema } from './input.js';

export const staffDto = (row: {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  mfaEnabled: boolean;
}) => ({
  id: row.id,
  email: row.email,
  role: row.role,
  isActive: row.isActive,
  mfaEnabled: row.mfaEnabled,
});

export class StaffService {
  async list(tx: Transaction, query: unknown, actor: string, requestId: string) {
    const { page, pageSize } = validated(paginationSchema, query);
    const [rows, total] = await Promise.all([
      tx.staffUser.findMany({
        orderBy: { email: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.staffUser.count(),
    ]);
    await writeAudit(tx, 'STAFF_READ', 'staff', null, requestId, actor);
    return { items: rows.map(staffDto), pagination: { page, pageSize, total } };
  }
  async get(tx: Transaction, idInput: unknown, actor: string, requestId: string) {
    const id = validated(uuidSchema, idInput);
    const row = await tx.staffUser.findUnique({ where: { id } });
    if (!row) throw new AccessError(404, 'NOT_FOUND');
    await writeAudit(tx, 'STAFF_READ', 'staff', id, requestId, actor);
    return staffDto(row);
  }
  async create(tx: Transaction, input: unknown, actor: string, requestId: string) {
    const data = validated(staffCreateSchema, input);
    const row = await tx.staffUser.create({
      data: {
        ...data,
        isActive: false,
        passwordHash: `DISABLED-${randomBytes(32).toString('hex')}`,
      },
    });
    await writeAudit(tx, 'STAFF_CREATED', 'staff', row.id, requestId, actor);
    return staffDto(row);
  }
  async patch(tx: Transaction, id: string, input: unknown, actor: string, requestId: string) {
    const data = validated(staffPatchSchema, input);
    const row = await tx.staffUser.findUnique({ where: { id } });
    if (!row) throw new AccessError(404, 'NOT_FOUND');
    if (
      data.isActive === true &&
      (!row.mfaEnabled || !row.mfaSecretCiphertext || !row.passwordHash.startsWith('$argon2id$'))
    )
      throw new AccessError(409, 'CREDENTIALS_NOT_PROVISIONED');
    if (
      row.role === 'ADMIN' &&
      row.isActive &&
      (data.role === 'RECEPTIONIST' || data.isActive === false)
    ) {
      const remaining = await tx.staffUser.count({
        where: { role: 'ADMIN', isActive: true, mfaEnabled: true, id: { not: id } },
      });
      if (!remaining) throw new AccessError(409, 'LAST_ADMIN_REQUIRED');
    }
    const updated = await tx.staffUser.update({
      where: { id },
      data: {
        ...(data.role !== undefined ? { role: data.role } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
    await writeAudit(tx, 'STAFF_UPDATED', 'staff', id, requestId, actor, Object.keys(data));
    return staffDto(updated);
  }
  async revoke(tx: Transaction, id: string, actor: string, requestId: string, now: Date) {
    if (!(await tx.staffUser.findUnique({ where: { id }, select: { id: true } })))
      throw new AccessError(404, 'NOT_FOUND');
    await tx.staffSession.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: now },
    });
    await writeAudit(tx, 'STAFF_SESSIONS_REVOKED', 'staff', id, requestId, actor);
  }
}
