import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { lockDoctors } from '../modules/booking/repository.js';
import type { SealedContacts } from '../modules/booking/input.js';

export const syntheticIds = {
  doctors: ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'],
  services: [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
  ],
  consent: '30000000-0000-4000-8000-000000000001',
  staff: '40000000-0000-4000-8000-000000000001',
  windows: [
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000004',
  ],
} as const;

const offers = [
  {
    slug: 'synthetic-therapy',
    nameRu: 'Синтетическая консультация',
    nameKk: 'Синтетикалық кеңес',
    durationMinutes: 30,
    priceKzt: '9000.00',
  },
  {
    slug: 'synthetic-cardiology',
    nameRu: 'Синтетический расширенный приём',
    nameKk: 'Синтетикалық кеңейтілген қабылдау',
    durationMinutes: 45,
    priceKzt: '12000.00',
  },
  {
    slug: 'synthetic-diagnostics',
    nameRu: 'Синтетическая диагностика',
    nameKk: 'Синтетикалық диагностика',
    durationMinutes: 25,
    priceKzt: '11000.00',
  },
] as const;

export async function seedSyntheticClinic(client: PrismaClient, day: Date, publishedAt: Date) {
  const at = (hours: number) => {
    const result = new Date(day);
    result.setUTCHours(hours, 0, 0, 0);
    return result;
  };
  const textRu = 'СИНТЕТИЧЕСКИЙ ТЕСТ. Не является юридическим согласием реальной клиники.';
  const textKk = 'СИНТЕТИКАЛЫҚ ТЕСТ. Нақты клиниканың заңды келісімі емес.';
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(927411991::bigint)`;
      for (const [i, id] of syntheticIds.doctors.entries()) {
        await tx.doctor.upsert({
          where: { id },
          update: {},
          create: {
            id,
            slug: `synthetic-doctor-${i + 1}`,
            nameRu: `Синтетический врач ${i + 1}`,
            nameKk: `Синтетикалық дәрігер ${i + 1}`,
            specialtyRu: 'Тестовое направление',
            specialtyKk: 'Сынақ бағыты',
            bioRu: 'Вымышленные данные для разработки.',
            bioKk: 'Әзірлеуге арналған ойдан шығарылған деректер.',
          },
        });
      }
      await lockDoctors(tx, [...syntheticIds.doctors]);
      for (const [i, id] of syntheticIds.services.entries()) {
        const offer = offers[i];
        if (!offer) throw new Error('Missing synthetic offer');
        await tx.service.upsert({ where: { id }, update: {}, create: { id, ...offer } });
      }
      for (const doctorId of syntheticIds.doctors) {
        for (const serviceId of syntheticIds.services) {
          await tx.doctorService.upsert({
            where: { doctorId_serviceId: { doctorId, serviceId } },
            update: {},
            create: { doctorId, serviceId },
          });
        }
      }
      for (const [i, id] of syntheticIds.windows.entries()) {
        const doctorId = syntheticIds.doctors[Math.floor(i / 2)];
        if (!doctorId) throw new Error('Missing synthetic doctor');
        await tx.availabilityWindow.upsert({
          where: { id },
          update: {},
          create: {
            id,
            doctorId,
            startsAt: at(i % 2 === 0 ? 4 : 8),
            endsAt: at(i % 2 === 0 ? 7 : 11),
          },
        });
      }
      await tx.consentDocument.upsert({
        where: { id: syntheticIds.consent },
        update: {},
        create: {
          id: syntheticIds.consent,
          version: 'synthetic-v1',
          textRu,
          textKk,
          publishedAt,
          contentSha256: createHash('sha256')
            .update(JSON.stringify([textRu, textKk]))
            .digest('hex'),
        },
      });
      await tx.staffUser.upsert({
        where: { id: syntheticIds.staff },
        update: {},
        create: {
          id: syntheticIds.staff,
          email: 'synthetic-admin@example.invalid',
          passwordHash: `DISABLED-${randomBytes(32).toString('hex')}`,
          role: 'ADMIN',
          isActive: false,
          mfaEnabled: false,
        },
      });
    },
    { timeout: 15_000 },
  );
}

// Only fixtures use this ephemeral key. This is not the production privacy/key-management module.
export function syntheticContacts(
  key: Uint8Array,
  identity = 'synthetic-visitor-001',
): SealedContacts {
  function seal(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
  }
  return {
    patientNameCiphertext: seal(`Синтетический посетитель ${identity}`),
    phoneCiphertext: seal('+70000000000'),
    encryptionKeyVersion: 'synthetic-ephemeral-v1',
    fingerprint: createHmac('sha256', key)
      .update(JSON.stringify([identity, '+70000000000']))
      .digest('hex'),
  };
}
