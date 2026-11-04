import { Prisma } from '../../generated/prisma/client.js';
import type { Transaction } from './transaction.js';
import { BookingError } from './errors.js';

export const appointmentSelection = {
  id: true,
  reference: true,
  doctorId: true,
  serviceId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  version: true,
  priceKztSnapshot: true,
  durationMinutesSnapshot: true,
} satisfies Prisma.AppointmentSelect;

export type AppointmentRecord = Prisma.AppointmentGetPayload<{
  select: typeof appointmentSelection;
}>;
export function safeAppointment(row: AppointmentRecord) {
  return {
    id: row.id,
    reference: row.reference,
    doctorId: row.doctorId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    version: row.version,
    priceKzt: row.priceKztSnapshot.toFixed(2),
    durationMinutes: row.durationMinutesSnapshot,
  };
}

export async function lockDoctors(tx: Transaction, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM doctors WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw new BookingError('DOCTOR_NOT_FOUND');
  }
}
export async function lockServices(tx: Transaction, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM services WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw new BookingError('SERVICE_NOT_FOUND');
  }
}
export async function lockAppointment(tx: Transaction, id: string) {
  await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.appointment.findUniqueOrThrow({ where: { id }, select: appointmentSelection });
}
export async function activeOffer(tx: Transaction, doctorId: string, serviceId: string) {
  const assignment = await tx.doctorService.findUnique({
    where: { doctorId_serviceId: { doctorId, serviceId } },
    include: { doctor: true, service: true },
  });
  if (!assignment?.isActive || !assignment.doctor.isActive || !assignment.service.isActive) {
    throw new BookingError('INACTIVE_SELECTION');
  }
  return assignment.service;
}
export function audit(
  tx: Transaction,
  action: string,
  entityType: string,
  entityId: string,
  requestId: string,
) {
  return tx.auditEvent.create({ data: { action, entityType, entityId, requestId } });
}
