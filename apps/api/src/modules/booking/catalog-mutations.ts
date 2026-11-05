import type { Transaction } from './transaction.js';
import { lockDoctors, lockServices } from './repository.js';
export interface DoctorMutation {
  nameRu?: string;
  nameKk?: string;
  specialtyRu?: string;
  specialtyKk?: string;
  bioRu?: string;
  bioKk?: string;
  photoAssetKey?: string | null;
  isActive?: boolean;
}
export interface ServiceMutation {
  nameRu?: string;
  nameKk?: string;
  descriptionRu?: string;
  descriptionKk?: string;
  priceKzt?: string;
  durationMinutes?: number;
  isActive?: boolean;
}
export async function updateDoctorLocked(tx: Transaction, id: string, data: DoctorMutation) {
  await lockDoctors(tx, [id]);
  return tx.doctor.update({ where: { id }, data });
}
export async function updateServiceLocked(tx: Transaction, id: string, data: ServiceMutation) {
  await lockServices(tx, [id]);
  return tx.service.update({ where: { id }, data });
}
export async function setAssignmentLocked(
  tx: Transaction,
  doctorId: string,
  serviceId: string,
  isActive: boolean,
  allowCreate = false,
) {
  await lockDoctors(tx, [doctorId]);
  await lockServices(tx, [serviceId]);
  const where = { doctorId_serviceId: { doctorId, serviceId } };
  return allowCreate
    ? tx.doctorService.upsert({
        where,
        create: { doctorId, serviceId, isActive },
        update: { isActive },
      })
    : tx.doctorService.update({ where, data: { isActive } });
}
