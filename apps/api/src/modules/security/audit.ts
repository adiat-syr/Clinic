import { z } from 'zod';
import type { Transaction } from '../booking/transaction.js';
import { paginationSchema } from './input.js';
import { AccessError, validated } from './errors.js';
import { writeAudit } from './repository.js';

export const auditQuerySchema = paginationSchema.extend({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export const auditMetadataSchema = z.strictObject({
  fields: z
    .array(
      z.enum([
        'nameRu',
        'nameKk',
        'specialtyRu',
        'specialtyKk',
        'bioRu',
        'bioKk',
        'photoAssetKey',
        'isActive',
        'descriptionRu',
        'descriptionKk',
        'priceKzt',
        'durationMinutes',
        'services',
        'role',
      ]),
    )
    .max(20)
    .optional(),
});

export class AuditService {
  async list(tx: Transaction, input: unknown, actor: string, requestId: string, now: Date) {
    const query = validated(auditQuerySchema, input);
    const to = query.to ? new Date(query.to) : now;
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 7 * 86400000);
    if (from >= to || to.getTime() - from.getTime() > 31 * 86400000)
      throw new AccessError(400, 'INVALID_DATE_RANGE');
    const where = { createdAt: { gte: from, lte: to } };
    const [rows, total] = await Promise.all([
      tx.auditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.auditEvent.count({ where }),
    ]);
    await writeAudit(tx, 'AUDIT_READ', 'audit', null, requestId, actor);
    return {
      items: rows.map((row) => {
        const metadata = auditMetadataSchema.safeParse(row.metadata);
        return {
          id: row.id,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          actorUserId: row.actorUserId,
          requestId: row.requestId,
          createdAt: row.createdAt.toISOString(),
          metadata: metadata.success ? metadata.data : {},
        };
      }),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }
}
