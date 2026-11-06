import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import { BookingService } from './service.js';
import { ContactPrivacy, type PrivacyConfig, contactsSchema } from './privacy.js';
import { selectionSchema, windowSchema, moveSchema, transitionSchema, uuid } from './input.js';
import { paginationSchema } from '../security/input.js';
import { validated, AccessError } from '../security/errors.js';
import { writeAudit } from '../security/repository.js';
import { withTransaction, type Transaction } from './transaction.js';
import { lockDoctors, lockServices, lockAppointment, safeAppointment } from './repository.js';

const appointmentLabelsInclude = {
  doctorService: {
    select: {
      doctor: { select: { nameRu: true, nameKk: true } },
      service: { select: { nameRu: true, nameKk: true } },
    },
  },
};
function appointmentLabels(row: {
  doctorService: {
    doctor: { nameRu: string; nameKk: string };
    service: { nameRu: string; nameKk: string };
  };
}) {
  return {
    doctorNameRu: row.doctorService.doctor.nameRu,
    doctorNameKk: row.doctorService.doctor.nameKk,
    serviceNameRu: row.doctorService.service.nameRu,
    serviceNameKk: row.doctorService.service.nameKk,
  };
}

export const publicBookingSchema = selectionSchema.extend({
  contacts: contactsSchema,
  consent: z.strictObject({
    documentId: uuid,
    accepted: z.literal(true),
    locale: z.enum(['ru', 'kk']),
  }),
});
export const patientConsentSchema = publicBookingSchema.pick({ contacts: true, consent: true });
export const staffBookingSchema = selectionSchema.extend({
  consentCode: z.string().regex(/^[a-f0-9]{32}$/),
});
export function consentCodeHash(code: string) {
  return createHash('sha256')
    .update('clinic:patient-consent:' + code)
    .digest('hex');
}
export const availabilityQuery = z.strictObject({
  doctorId: uuid,
  serviceId: uuid,
  date: z.iso.date(),
});
export const rangeQuery = paginationSchema.extend({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  doctorId: uuid.optional(),
});
export const appointmentQuery = rangeQuery.extend({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']).optional(),
});
export const appointmentCommand = z.discriminatedUnion('action', [
  transitionSchema.omit({ appointmentId: true }).extend({ action: z.literal('status') }),
  moveSchema.omit({ appointmentId: true }).extend({ action: z.literal('reschedule') }),
]);
export const withdrawalSchema = z.strictObject({
  version: z.number().int().positive(),
  confirmedIdentity: z.literal(true),
});
export const publishSchema = z.strictObject({
  version: z.string().min(1).max(80),
  textRu: z.string().min(20).max(50000),
  textKk: z.string().min(20).max(50000),
});
export { windowSchema };

function localMidnight(date: string, zone: string) {
  const target = Date.parse(date + 'T00:00:00Z');
  let value = target;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(value)).map((x) => [x.type, x.value]),
    );
    const displayed = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    const delta = target - displayed;
    if (delta === 0) return new Date(value);
    value += delta;
  }
  throw new AccessError(400, 'INVALID_DATE_RANGE');
}
function windowDto(row: {
  id: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    doctorId: row.doctorId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export class BookingHttpService {
  onlineBookingAllowed = true;
  withdrawalJournal?: WithdrawalJournal;
  async withWithdrawalLock<T>(work: () => Promise<T>): Promise<T> {
    if (!this.withdrawalJournal) return work();
    let entered = false;
    try {
      return await this.withdrawalJournal.withLock(() => {
        entered = true;
        return work();
      });
    } catch (error) {
      if (entered) throw error;
      throw new AccessError(503, 'PRIVACY_JOURNAL_UNAVAILABLE');
    }
  }
  phoneConsentAllowed = true;
  readonly core: BookingService;
  readonly privacy: ContactPrivacy;
  constructor(
    readonly client: PrismaClient,
    readonly config: PrivacyConfig,
    readonly now: () => Date = () => new Date(),
    readonly approvedConsentHash?: string,
  ) {
    this.privacy = new ContactPrivacy(config);
    this.core = new BookingService(client, {
      idempotencySecret: config.hmacKey,
      now,
      ...(approvedConsentHash ? { approvedConsentHash } : {}),
    });
  }
  async issueConsentCode(input: unknown) {
    if (!this.onlineBookingAllowed) throw new AccessError(503, 'BOOKING_NOT_ENABLED');
    if (!this.phoneConsentAllowed) throw new AccessError(403, 'PHONE_CONSENT_NOT_APPROVED');
    const command = validated(patientConsentSchema, input);
    return withTransaction(this.client, async (tx) => {
      const now = this.now();
      await tx.$queryRaw`SELECT id FROM consent_documents WHERE id=${command.consent.documentId}::uuid FOR SHARE`;
      const document = await tx.consentDocument.findUnique({
        where: { id: command.consent.documentId },
      });
      if (
        !document ||
        document.retiredAt ||
        document.publishedAt > now ||
        (this.approvedConsentHash && document.contentSha256 !== this.approvedConsentHash)
      )
        throw new AccessError(409, 'CONSENT_CHANGED');
      const code = randomBytes(16).toString('hex'),
        expiresAt = new Date(now.getTime() + 5 * 60000);
      await tx.patientConsentReceipt.create({
        data: {
          codeHash: consentCodeHash(code),
          documentId: document.id,
          locale: command.consent.locale,
          acceptedAt: now,
          expiresAt,
          ...this.privacy.sealContacts(command.contacts),
        },
      });
      return { code, expiresAt: expiresAt.toISOString(), documentVersion: document.version };
    });
  }
  async staffCreate(
    tx: Transaction,
    input: unknown,
    key: unknown,
    actor: string,
    requestId: string,
  ) {
    if (!this.phoneConsentAllowed) throw new AccessError(403, 'PHONE_CONSENT_NOT_APPROVED');
    if (!this.onlineBookingAllowed) throw new AccessError(503, 'BOOKING_NOT_ENABLED');
    const command = validated(staffBookingSchema, input),
      idempotencyKey = validated(z.string().regex(/^[a-fA-F0-9]{32,128}$/), key),
      hash = consentCodeHash(command.consentCode),
      receipt = await tx.patientConsentReceipt.findUnique({ where: { codeHash: hash } });
    if (!receipt) throw new AccessError(409, 'CONSENT_CODE_UNAVAILABLE');
    const row = await this.core.inTransaction(tx, actor, requestId).create({
      doctorId: command.doctorId,
      serviceId: command.serviceId,
      startsAt: command.startsAt.toISOString(),
      expectedPriceKzt: command.expectedPriceKzt,
      expectedDurationMinutes: command.expectedDurationMinutes,
      idempotencyKey,
      contacts: {
        patientNameCiphertext: receipt.patientNameCiphertext,
        phoneCiphertext: receipt.phoneCiphertext,
        encryptionKeyVersion: receipt.encryptionKeyVersion,
        fingerprint: receipt.fingerprint,
      },
      consent: {
        documentId: receipt.documentId,
        locale: receipt.locale,
        accepted: true,
        receiptHash: hash,
      },
    });
    if (!row.replayed)
      await writeAudit(tx, 'STAFF_APPOINTMENT_CREATED', 'appointment', row.id, requestId, actor);
    return {
      body: {
        reference: row.reference,
        status: row.status,
        doctorId: row.doctorId,
        serviceId: row.serviceId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        priceKzt: row.priceKzt,
        durationMinutes: row.durationMinutes,
      },
      replayed: row.replayed,
    };
  }
  async create(input: unknown, key: unknown) {
    if (!this.onlineBookingAllowed) throw new AccessError(503, 'BOOKING_NOT_ENABLED');
    const command = validated(publicBookingSchema, input),
      idempotencyKey = validated(z.string().regex(/^[a-fA-F0-9]{32,128}$/), key);
    const row = await this.core.create({
      ...command,
      startsAt: command.startsAt.toISOString(),
      idempotencyKey,
      contacts: this.privacy.sealContacts(command.contacts),
    });
    return {
      body: {
        reference: row.reference,
        status: row.status,
        doctorId: row.doctorId,
        serviceId: row.serviceId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        priceKzt: row.priceKzt,
        durationMinutes: row.durationMinutes,
      },
      replayed: row.replayed,
    };
  }
  async availability(input: unknown) {
    const q = validated(availabilityQuery, input),
      from = localMidnight(q.date, this.config.timeZone);
    const next = new Date(Date.parse(q.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10),
      to = localMidnight(next, this.config.timeZone);
    if (to <= this.now() || from.getTime() > this.now().getTime() + 60 * 86400000)
      throw new AccessError(400, 'INVALID_DATE_RANGE');
    return {
      ...(await this.core.availability({
        doctorId: q.doctorId,
        serviceId: q.serviceId,
        from: from.toISOString(),
        to: to.toISOString(),
      })),
      timeZone: this.config.timeZone,
      date: q.date,
    };
  }
  private range(input: unknown) {
    const q = validated(appointmentQuery, input);
    const from = new Date(q.from),
      to = new Date(q.to);
    if (from >= to || to.getTime() - from.getTime() > 31 * 86400000)
      throw new AccessError(400, 'INVALID_DATE_RANGE');
    return { ...q, from, to };
  }
  async windows(tx: Transaction, input: unknown) {
    validated(rangeQuery, input);
    const q = this.range(input),
      where = {
        startsAt: { lt: q.to },
        endsAt: { gt: q.from },
        ...(q.doctorId ? { doctorId: q.doctorId } : {}),
      };
    const [rows, total] = await Promise.all([
      tx.availabilityWindow.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.availabilityWindow.count({ where }),
    ]);
    return {
      items: rows.map(windowDto),
      pagination: { page: q.page, pageSize: q.pageSize, total },
    };
  }
  async createWindow(tx: Transaction, input: unknown, actor: string, requestId: string) {
    return windowDto(await this.core.inTransaction(tx, actor, requestId).createWindow(input));
  }
  async appointments(tx: Transaction, input: unknown, actor: string, requestId: string) {
    const q = this.range(input),
      where: Prisma.AppointmentWhereInput = {
        startsAt: { gte: q.from, lt: q.to },
        ...(q.doctorId ? { doctorId: q.doctorId } : {}),
        ...(q.status ? { status: q.status } : {}),
      };
    const [rows, total] = await Promise.all([
      tx.appointment.findMany({
        where,
        include: appointmentLabelsInclude,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      tx.appointment.count({ where }),
    ]);
    await writeAudit(tx, 'APPOINTMENTS_READ', 'appointment', null, requestId, actor);
    return {
      items: rows.map((row) => ({ ...safeAppointment(row), ...appointmentLabels(row) })),
      pagination: { page: q.page, pageSize: q.pageSize, total },
    };
  }
  async appointment(tx: Transaction, idInput: unknown, actor: string, requestId: string) {
    const id = validated(uuid, idInput),
      row = await tx.appointment.findUnique({
        where: { id },
        include: { consent: true, ...appointmentLabelsInclude },
      });
    if (!row) throw new AccessError(404, 'NOT_FOUND');
    await writeAudit(tx, 'APPOINTMENT_CONTACTS_READ', 'appointment', id, requestId, actor);
    const contacts =
      row.patientNameCiphertext && row.phoneCiphertext && row.encryptionKeyVersion
        ? {
            name: this.privacy.open(row.patientNameCiphertext, row.encryptionKeyVersion, 'name'),
            phone: this.privacy.open(row.phoneCiphertext, row.encryptionKeyVersion, 'phone'),
          }
        : null;
    return {
      ...safeAppointment(row),
      ...appointmentLabels(row),
      contacts,
      consent: row.consent
        ? {
            documentId: row.consent.documentId,
            acceptedAt: row.consent.acceptedAt.toISOString(),
            withdrawnAt: row.consent.withdrawnAt?.toISOString() ?? null,
          }
        : null,
    };
  }
  async change(tx: Transaction, id: unknown, input: unknown, actor: string, requestId: string) {
    const appointmentId = validated(uuid, id),
      { action, ...command } = validated(appointmentCommand, input),
      core = this.core.inTransaction(tx, actor, requestId);
    return action === 'status'
      ? core.transition({ ...command, appointmentId })
      : core.reschedule({
          ...command,
          appointmentId,
          startsAt: 'startsAt' in command ? command.startsAt.toISOString() : undefined,
        });
  }
  async withdraw(
    tx: Transaction,
    idInput: unknown,
    input: unknown,
    actor: string,
    requestId: string,
  ) {
    const id = validated(uuid, idInput),
      command = validated(withdrawalSchema, input),
      initial = await tx.appointment.findUnique({ where: { id } });
    if (!initial) throw new AccessError(404, 'NOT_FOUND');
    await lockDoctors(tx, [initial.doctorId]);
    await lockServices(tx, [initial.serviceId]);
    const current = await lockAppointment(tx, id);
    if (
      current.version !== command.version ||
      current.doctorId !== initial.doctorId ||
      current.serviceId !== initial.serviceId
    )
      throw new AccessError(409, 'VERSION_CONFLICT');
    const consent = await tx.appointmentConsent.findUniqueOrThrow({ where: { appointmentId: id } });
    if (consent.withdrawnAt) throw new AccessError(409, 'CONSENT_ALREADY_WITHDRAWN');
    const withdrawnAt = this.now();
    if (this.withdrawalJournal) {
      try {
        await this.withdrawalJournal.record({
          appointmentId: id,
          documentId: consent.documentId,
          operationId: randomUUID(),
          actorId: actor,
          requestId,
          withdrawnAt: withdrawnAt.toISOString(),
        });
      } catch {
        throw new AccessError(503, 'PRIVACY_JOURNAL_UNAVAILABLE');
      }
    }
    await tx.appointmentConsent.update({
      where: { appointmentId: id },
      data: { withdrawnAt },
    });
    await tx.appointment.update({ where: { id }, data: { version: { increment: 1 } } });
    await writeAudit(tx, 'CONSENT_WITHDRAWAL_RECORDED', 'appointment', id, requestId, actor);
    return { recorded: true, version: current.version + 1 };
  }
  async consent(input: unknown) {
    const { locale } = validated(z.strictObject({ locale: z.enum(['ru', 'kk']) }), input);
    const row = await this.client.consentDocument.findFirst({
      where: { retiredAt: null, publishedAt: { lte: this.now() } },
    });
    if (!row) throw new AccessError(404, 'NOT_FOUND');
    if (this.approvedConsentHash && row.contentSha256 !== this.approvedConsentHash)
      throw new AccessError(409, 'CONSENT_CHANGED');

    return {
      id: row.id,
      version: row.version,
      locale,
      text: locale === 'ru' ? row.textRu : row.textKk,
      contentSha256: row.contentSha256,
    };
  }
  publish(input: unknown) {
    const data = validated(publishSchema, input);
    return withTransaction(this.client, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(75004,1)`;
      const now = this.now();
      await tx.consentDocument.updateMany({ where: { retiredAt: null }, data: { retiredAt: now } });
      const row = await tx.consentDocument.create({
        data: {
          ...data,
          publishedAt: now,
          contentSha256: createHash('sha256')
            .update(JSON.stringify([data.textRu, data.textKk]))
            .digest('hex'),
        },
      });
      await writeAudit(tx, 'CONSENT_PUBLISHED', 'consent_document', row.id, randomUUID(), null);
      return { id: row.id, version: row.version };
    });
  }
}
export interface WithdrawalJournal {
  withLock<T>(work: () => Promise<T>): Promise<T>;
  record(input: {
    appointmentId: string;
    documentId: string;
    operationId: string;
    withdrawnAt: string;
    actorId: string;
    requestId: string;
  }): Promise<void>;
}
