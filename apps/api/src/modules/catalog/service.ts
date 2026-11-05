import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { validated, AccessError } from '../security/errors.js';
import { writeAudit } from '../security/repository.js';
import { paginationSchema, uuidSchema } from '../security/input.js';
import type { Transaction } from '../booking/transaction.js';
import {
  updateDoctorLocked,
  updateServiceLocked,
  setAssignmentLocked,
} from '../booking/catalog-mutations.js';
import type { DoctorMutation, ServiceMutation } from '../booking/catalog-mutations.js';
import * as dto from './schemas.js';

type DoctorRow = Prisma.DoctorGetPayload<{ include: { services: { include: { service: true } } } }>;
type ServiceRow = Prisma.ServiceGetPayload<object>;
function serviceDto(row: ServiceRow, admin: boolean) {
  const publicData = {
    id: row.id,
    slug: row.slug,
    nameRu: row.nameRu,
    nameKk: row.nameKk,
    descriptionRu: row.descriptionRu,
    descriptionKk: row.descriptionKk,
    durationMinutes: row.durationMinutes,
    priceKzt: row.priceKzt.toFixed(2),
  };
  return admin
    ? dto.adminServiceSchema.parse({ ...publicData, isActive: row.isActive })
    : dto.publicServiceSchema.parse(publicData);
}
function doctorDto(row: DoctorRow, admin: boolean) {
  const fields = {
    id: row.id,
    slug: row.slug,
    nameRu: row.nameRu,
    nameKk: row.nameKk,
    specialtyRu: row.specialtyRu,
    specialtyKk: row.specialtyKk,
    bioRu: row.bioRu,
    bioKk: row.bioKk,
    photoAssetKey: row.photoAssetKey,
  };
  if (admin)
    return dto.adminDoctorSchema.parse({
      ...fields,
      isActive: row.isActive,
      services: row.services.map((link) => ({
        isActive: link.isActive,
        service: serviceDto(link.service, true),
      })),
    });
  return dto.publicDoctorSchema.parse({
    ...fields,
    services: row.services
      .filter((link) => link.isActive && link.service.isActive)
      .map((link) => serviceDto(link.service, false)),
  });
}
const includeDoctor = {
  services: { include: { service: true }, orderBy: { serviceId: 'asc' as const } },
};
function defined<T extends object>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export class CatalogService {
  constructor(readonly client: PrismaClient) {}
  async doctors(query: unknown, admin = false, tx: Transaction = this.client) {
    const { page, pageSize } = validated(paginationSchema, query);
    const where = admin ? {} : { isActive: true };
    const [rows, total] = await Promise.all([
      tx.doctor.findMany({
        where,
        include: includeDoctor,
        orderBy: { slug: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.doctor.count({ where }),
    ]);
    return {
      items: rows.map((row) => doctorDto(row, admin)),
      pagination: { page, pageSize, total },
    };
  }
  async services(query: unknown, admin = false, tx: Transaction = this.client) {
    const { page, pageSize } = validated(paginationSchema, query);
    const where = admin ? {} : { isActive: true };
    const [rows, total] = await Promise.all([
      tx.service.findMany({
        where,
        orderBy: { slug: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      tx.service.count({ where }),
    ]);
    return {
      items: rows.map((row) => serviceDto(row, admin)),
      pagination: { page, pageSize, total },
    };
  }
  async doctor(identifier: string, admin = false, tx: Transaction = this.client) {
    const where = admin
      ? { id: validated(uuidSchema, identifier) }
      : { slug: validated(dto.publicSlugSchema, identifier), isActive: true };
    const row = await tx.doctor.findFirst({ where, include: includeDoctor });
    if (!row) throw new AccessError(404, 'NOT_FOUND');
    return doctorDto(row, admin);
  }
  async service(identifier: string, admin = false, tx: Transaction = this.client) {
    const where = admin
      ? { id: validated(uuidSchema, identifier) }
      : { slug: validated(dto.publicSlugSchema, identifier), isActive: true };
    const row = await tx.service.findFirst({ where });
    if (!row) throw new AccessError(404, 'NOT_FOUND');
    return serviceDto(row, admin);
  }
  async createDoctor(tx: Transaction, input: unknown, actor: string, requestId: string) {
    const data = validated(dto.doctorCreateSchema, input);
    const row = await tx.doctor.create({ data });
    await writeAudit(tx, 'DOCTOR_CREATED', 'doctor', row.id, requestId, actor);
    return this.doctor(row.id, true, tx);
  }
  async patchDoctor(
    tx: Transaction,
    idInput: string,
    input: unknown,
    actor: string,
    requestId: string,
  ) {
    const id = validated(uuidSchema, idInput);
    const patch = validated(dto.doctorPatchSchema, input);
    await updateDoctorLocked(tx, id, defined(patch) as DoctorMutation);
    await writeAudit(tx, 'DOCTOR_UPDATED', 'doctor', id, requestId, actor, Object.keys(patch));
    return this.doctor(id, true, tx);
  }
  async createService(tx: Transaction, input: unknown, actor: string, requestId: string) {
    const row = await tx.service.create({ data: validated(dto.serviceCreateSchema, input) });
    await writeAudit(tx, 'SERVICE_CREATED', 'service', row.id, requestId, actor);
    return serviceDto(row, true);
  }
  async patchService(
    tx: Transaction,
    idInput: string,
    input: unknown,
    actor: string,
    requestId: string,
  ) {
    const id = validated(uuidSchema, idInput);
    const patch = validated(dto.servicePatchSchema, input);
    const row = await updateServiceLocked(tx, id, defined(patch) as ServiceMutation);
    await writeAudit(tx, 'SERVICE_UPDATED', 'service', id, requestId, actor, Object.keys(patch));
    return serviceDto(row, true);
  }
  async assignment(
    tx: Transaction,
    doctorInput: string,
    serviceInput: string,
    input: unknown,
    actor: string,
    requestId: string,
  ) {
    const doctorId = validated(uuidSchema, doctorInput);
    const serviceId = validated(uuidSchema, serviceInput);
    const command = validated(dto.assignmentSchema, input);
    await setAssignmentLocked(tx, doctorId, serviceId, command.isActive, true);
    await writeAudit(tx, 'DOCTOR_SERVICE_UPDATED', 'doctor', doctorId, requestId, actor, [
      'services',
    ]);
    return { doctorId, serviceId, isActive: command.isActive };
  }
}
