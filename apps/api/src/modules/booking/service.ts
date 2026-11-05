import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { BookingError } from './errors.js';
import {
  updateDoctorLocked,
  updateServiceLocked,
  setAssignmentLocked,
} from './catalog-mutations.js';
import {
  bookingSchema,
  moveSchema,
  parse,
  rangeSchema,
  serviceChangeSchema,
  transitionSchema,
  uuid,
  windowSchema,
} from './input.js';
import {
  activeOffer,
  appointmentSelection,
  lockAppointment,
  lockDoctors,
  lockServices,
  safeAppointment,
} from './repository.js';
import { withTransaction, type Transaction } from './transaction.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
type Interval = { startsAt: Date; endsAt: Date };

interface BookingOptions {
  idempotencySecret: Uint8Array;
  transaction?: Transaction;
  actorId?: string;
  requestId?: string;
  now?: () => Date;
  slotStepMinutes?: number;
  minimumLeadMinutes?: number;
  horizonDays?: number;
}

export class BookingService {
  private readonly secret: Uint8Array;
  private readonly now: () => Date;
  private readonly step: number;
  private readonly lead: number;
  private readonly horizon: number;

  constructor(
    private readonly client: PrismaClient,
    private readonly options: BookingOptions,
  ) {
    if (options.idempotencySecret.length < 32)
      throw new Error('A server-side HMAC key is required');
    this.secret = new Uint8Array(options.idempotencySecret);
    this.now = options.now ?? (() => new Date());
    const step = options.slotStepMinutes ?? 15;
    const lead = options.minimumLeadMinutes ?? 60;
    const horizon = options.horizonDays ?? 60;
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      step > 60 ||
      !Number.isInteger(lead) ||
      lead < 0 ||
      !Number.isInteger(horizon) ||
      horizon < 1 ||
      horizon > 90
    )
      throw new Error('Invalid booking policy');
    this.step = step * MINUTE;
    this.lead = lead * MINUTE;
    this.horizon = horizon * DAY;
  }

  private transact<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.options.transaction
      ? work(this.options.transaction)
      : withTransaction(this.client, work);
  }
  inTransaction(tx: Transaction, actorId: string, requestId: string) {
    return new BookingService(this.client, {
      ...this.options,
      transaction: tx,
      actorId,
      requestId,
    });
  }
  private audit(tx: Transaction, action: string, entity: string, id: string, requestId: string) {
    return tx.auditEvent.create({
      data: {
        action,
        entityType: entity,
        entityId: id,
        requestId: this.options.requestId ?? requestId,
        actorUserId: this.options.actorId ?? null,
      },
    });
  }
  private validateWindow(window: Interval) {
    const length = window.endsAt.getTime() - window.startsAt.getTime();
    if (
      length <= 0 ||
      length > DAY ||
      window.startsAt.getTime() % MINUTE !== 0 ||
      window.endsAt.getTime() % MINUTE !== 0
    )
      throw new BookingError('INVALID_WORKING_INTERVAL');
  }

  private checkOffer(
    offer: { priceKzt: Prisma.Decimal; durationMinutes: number },
    expected: {
      expectedPriceKzt: string;
      expectedDurationMinutes: number;
    },
  ) {
    if (
      !offer.priceKzt.equals(expected.expectedPriceKzt) ||
      offer.durationMinutes !== expected.expectedDurationMinutes
    ) {
      throw new BookingError('OFFER_CHANGED');
    }
  }

  private async checkSlot(
    tx: Transaction,
    doctorId: string,
    startsAt: Date,
    duration: number,
    now: Date,
    excludeId?: string,
  ) {
    const start = startsAt.getTime();
    const endsAt = new Date(start + duration * MINUTE);
    if (start < now.getTime() + this.lead || start > now.getTime() + this.horizon) {
      throw new BookingError('OUTSIDE_BOOKING_HORIZON');
    }
    const window = await tx.availabilityWindow.findFirst({
      where: {
        doctorId,
        startsAt: { lte: startsAt },
        endsAt: { gte: endsAt },
      },
    });
    if (!window) throw new BookingError('OUTSIDE_WORKING_HOURS');
    if ((start - window.startsAt.getTime()) % this.step !== 0)
      throw new BookingError('INVALID_SLOT_START');
    const overlap = await tx.appointment.findFirst({
      where: {
        doctorId,
        status: { not: 'CANCELLED' },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (overlap) throw new BookingError('SLOT_UNAVAILABLE');
    return endsAt;
  }

  async create(input: unknown) {
    const command = parse(bookingSchema, input);
    const keyHash = createHash('sha256')
      .update(`clinic:booking:${command.idempotencyKey.toLowerCase()}`)
      .digest('hex');
    // Nonces/ciphertext/key versions may change on a retry; identity fingerprint is stable and server-derived.
    const requestHmac = createHmac('sha256', this.secret)
      .update(
        JSON.stringify([
          command.doctorId,
          command.serviceId,
          command.startsAt.toISOString(),
          new Prisma.Decimal(command.expectedPriceKzt).toFixed(2),
          command.expectedDurationMinutes,
          command.consent.documentId,
          command.consent.locale,
          command.contacts.fingerprint,
        ]),
      )
      .digest('hex');

    return this.transact(async (tx) => {
      // This additional lock is always FIRST; no other operation acquires it after a doctor lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Buffer.from(keyHash, 'hex').readBigInt64BE(0)}::bigint)`;
      let now = this.now();
      const previous = await tx.idempotencyKey.findUnique({ where: { keyHash } });
      if (previous) {
        if (previous.expiresAt <= now || !previous.appointmentId)
          throw new BookingError('IDEMPOTENCY_EXPIRED');
        if (
          !timingSafeEqual(
            Buffer.from(previous.requestHmac, 'hex'),
            Buffer.from(requestHmac, 'hex'),
          )
        ) {
          throw new BookingError('IDEMPOTENCY_CONFLICT');
        }
        const row = await tx.appointment.findUniqueOrThrow({
          where: { id: previous.appointmentId },
          select: appointmentSelection,
        });
        return { ...safeAppointment(row), replayed: true };
      }
      await lockDoctors(tx, [command.doctorId]);
      await lockServices(tx, [command.serviceId]);
      now = this.now();
      const offer = await activeOffer(tx, command.doctorId, command.serviceId);
      this.checkOffer(offer, command);
      const endsAt = await this.checkSlot(
        tx,
        command.doctorId,
        command.startsAt,
        offer.durationMinutes,
        now,
      );
      await tx.$queryRaw`SELECT id FROM consent_documents WHERE id = ${command.consent.documentId}::uuid FOR SHARE`;
      const document = await tx.consentDocument.findUnique({
        where: { id: command.consent.documentId },
      });
      if (!document || document.retiredAt !== null || document.publishedAt > now)
        throw new BookingError('CONSENT_CHANGED');
      const row = await tx.appointment.create({
        data: {
          doctorId: command.doctorId,
          serviceId: command.serviceId,
          startsAt: command.startsAt,
          endsAt,
          durationMinutesSnapshot: offer.durationMinutes,
          priceKztSnapshot: offer.priceKzt,
          patientNameCiphertext: command.contacts.patientNameCiphertext,
          phoneCiphertext: command.contacts.phoneCiphertext,
          encryptionKeyVersion: command.contacts.encryptionKeyVersion,
          consent: {
            create: { documentId: document.id, locale: command.consent.locale, acceptedAt: now },
          },
        },
        select: appointmentSelection,
      });
      await tx.idempotencyKey.create({
        data: {
          keyHash,
          requestHmac,
          appointmentId: row.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + DAY),
        },
      });
      return { ...safeAppointment(row), replayed: false };
    });
  }

  async availability(input: unknown) {
    const command = parse(rangeSchema, input);
    if (
      command.to <= command.from ||
      command.to.getTime() - command.from.getTime() > this.horizon
    ) {
      throw new BookingError('INVALID_DATE_RANGE');
    }
    return this.transact(async (tx) => {
      await lockDoctors(tx, [command.doctorId]);
      await lockServices(tx, [command.serviceId]);
      const offer = await activeOffer(tx, command.doctorId, command.serviceId);
      const now = this.now().getTime();
      const windows = await tx.availabilityWindow.findMany({
        where: {
          doctorId: command.doctorId,
          startsAt: { lt: command.to },
          endsAt: { gt: command.from },
        },
        orderBy: { startsAt: 'asc' },
      });
      const busy = await tx.appointment.findMany({
        where: {
          doctorId: command.doctorId,
          status: { not: 'CANCELLED' },
          startsAt: { lt: command.to },
          endsAt: { gt: command.from },
        },
        select: { startsAt: true, endsAt: true },
      });
      const slots: { startsAt: string; endsAt: string }[] = [];
      for (const window of windows) {
        const lower = Math.max(command.from.getTime(), now + this.lead, window.startsAt.getTime());
        const anchor = window.startsAt.getTime();
        for (
          let start = anchor + Math.ceil((lower - anchor) / this.step) * this.step;
          start <= now + this.horizon &&
          start + offer.durationMinutes * MINUTE <=
            Math.min(window.endsAt.getTime(), command.to.getTime());
          start += this.step
        ) {
          const end = start + offer.durationMinutes * MINUTE;
          if (!busy.some((row) => row.startsAt.getTime() < end && row.endsAt.getTime() > start)) {
            slots.push({
              startsAt: new Date(start).toISOString(),
              endsAt: new Date(end).toISOString(),
            });
          }
        }
      }
      return {
        serviceId: offer.id,
        priceKzt: offer.priceKzt.toFixed(2),
        durationMinutes: offer.durationMinutes,
        slots,
      };
    });
  }

  async createWindow(input: unknown) {
    const command = parse(windowSchema, input);
    this.validateWindow(command);
    return this.transact(async (tx) => {
      await lockDoctors(tx, [command.doctorId]);
      const window = await tx.availabilityWindow.create({ data: command });
      await this.audit(tx, 'WINDOW_CREATED', 'availability_window', window.id, randomUUID());
      return window;
    });
  }

  private async changeWindow(idInput: unknown, input: unknown | null) {
    const id = parse(uuid, idInput);
    const initial = await this.client.availabilityWindow.findUnique({ where: { id } });
    if (!initial) throw new BookingError('WINDOW_NOT_FOUND');
    const replacement = input === null ? null : parse(windowSchema, input);
    if (replacement) {
      this.validateWindow(replacement);
      if (replacement.doctorId !== initial.doctorId)
        throw new BookingError('WINDOW_DOCTOR_IMMUTABLE');
    }
    return this.transact(async (tx) => {
      await lockDoctors(tx, [initial.doctorId]);
      const current = await tx.availabilityWindow.findUnique({ where: { id } });
      if (!current) throw new BookingError('WINDOW_NOT_FOUND');
      const remaining = await tx.availabilityWindow.findMany({
        where: { doctorId: current.doctorId, id: { not: id } },
      });
      const finalWindows: Interval[] = replacement ? [...remaining, replacement] : remaining;
      const bookings = await tx.appointment.findMany({
        where: {
          doctorId: current.doctorId,
          status: { not: 'CANCELLED' },
          endsAt: { gt: this.now() },
        },
      });
      if (
        bookings.some(
          (booking) =>
            !finalWindows.some(
              (window) => window.startsAt <= booking.startsAt && window.endsAt >= booking.endsAt,
            ),
        )
      ) {
        throw new BookingError('SCHEDULE_HAS_APPOINTMENTS');
      }
      if (replacement) await tx.availabilityWindow.update({ where: { id }, data: replacement });
      else await tx.availabilityWindow.delete({ where: { id } });
      await this.audit(
        tx,
        replacement ? 'WINDOW_UPDATED' : 'WINDOW_DELETED',
        'availability_window',
        id,
        randomUUID(),
      );
    });
  }

  replaceWindow(id: unknown, input: unknown) {
    return this.changeWindow(id, input);
  }
  deleteWindow(id: unknown) {
    return this.changeWindow(id, null);
  }

  async reschedule(input: unknown) {
    const command = parse(moveSchema, input);
    const initial = await this.client.appointment.findUnique({
      where: { id: command.appointmentId },
      select: appointmentSelection,
    });
    if (!initial) throw new BookingError('APPOINTMENT_NOT_FOUND');
    return this.transact(async (tx) => {
      await lockDoctors(tx, [initial.doctorId, command.doctorId]);
      await lockServices(tx, [initial.serviceId, command.serviceId]);
      const current = await lockAppointment(tx, command.appointmentId);
      if (
        current.version !== command.version ||
        current.doctorId !== initial.doctorId ||
        current.serviceId !== initial.serviceId
      )
        throw new BookingError('VERSION_CONFLICT');
      if (!['PENDING', 'CONFIRMED'].includes(current.status) || current.startsAt <= this.now())
        throw new BookingError('INVALID_STATUS_TRANSITION');
      const offer = await activeOffer(tx, command.doctorId, command.serviceId);
      this.checkOffer(offer, command);
      const endsAt = await this.checkSlot(
        tx,
        command.doctorId,
        command.startsAt,
        offer.durationMinutes,
        this.now(),
        current.id,
      );
      const row = await tx.appointment.update({
        where: { id: current.id },
        data: {
          doctorId: command.doctorId,
          serviceId: command.serviceId,
          startsAt: command.startsAt,
          endsAt,
          priceKztSnapshot: offer.priceKzt,
          durationMinutesSnapshot: offer.durationMinutes,
          status: 'PENDING',
          version: { increment: 1 },
        },
        select: appointmentSelection,
      });
      await this.audit(tx, 'APPOINTMENT_RESCHEDULED', 'appointment', row.id, randomUUID());
      return safeAppointment(row);
    });
  }

  async transition(input: unknown) {
    const command = parse(transitionSchema, input);
    const initial = await this.client.appointment.findUnique({
      where: { id: command.appointmentId },
      select: appointmentSelection,
    });
    if (!initial) throw new BookingError('APPOINTMENT_NOT_FOUND');
    return this.transact(async (tx) => {
      await lockDoctors(tx, [initial.doctorId]);
      await lockServices(tx, [initial.serviceId]);
      const current = await lockAppointment(tx, initial.id);
      if (
        current.version !== command.version ||
        current.doctorId !== initial.doctorId ||
        current.serviceId !== initial.serviceId
      )
        throw new BookingError('VERSION_CONFLICT');
      const allowed =
        current.status === 'PENDING'
          ? ['CONFIRMED', 'CANCELLED']
          : current.status === 'CONFIRMED'
            ? ['CANCELLED', 'COMPLETED', 'NO_SHOW']
            : [];
      if (
        !allowed.includes(command.status) ||
        (command.status === 'CONFIRMED' && current.startsAt <= this.now()) ||
        (['COMPLETED', 'NO_SHOW'].includes(command.status) && current.endsAt > this.now())
      )
        throw new BookingError('INVALID_STATUS_TRANSITION');
      const row = await tx.appointment.update({
        where: { id: current.id },
        data: { status: command.status, version: { increment: 1 } },
        select: appointmentSelection,
      });
      await this.audit(tx, `APPOINTMENT_${command.status}`, 'appointment', row.id, randomUUID());
      return safeAppointment(row);
    });
  }

  async setDoctorActive(idInput: unknown, active: boolean) {
    const id = parse(uuid, idInput);
    if (typeof active !== 'boolean') throw new BookingError('INVALID_INPUT');
    return this.transact(async (tx) => {
      await updateDoctorLocked(tx, id, { isActive: active });
    });
  }

  async setAssignmentActive(doctorInput: unknown, serviceInput: unknown, active: boolean) {
    const doctorId = parse(uuid, doctorInput);
    const serviceId = parse(uuid, serviceInput);
    if (typeof active !== 'boolean') throw new BookingError('INVALID_INPUT');
    return this.transact(async (tx) => {
      await setAssignmentLocked(tx, doctorId, serviceId, active);
    });
  }

  async changeService(input: unknown) {
    const { serviceId, ...change } = parse(serviceChangeSchema, input);
    if (!Object.keys(change).length) throw new BookingError('INVALID_INPUT');
    return this.transact(async (tx) => {
      await updateServiceLocked(tx, serviceId, {
        ...(change.priceKzt !== undefined ? { priceKzt: change.priceKzt } : {}),
        ...(change.durationMinutes !== undefined
          ? { durationMinutes: change.durationMinutes }
          : {}),
        ...(change.isActive !== undefined ? { isActive: change.isActive } : {}),
      });
    });
  }
}
