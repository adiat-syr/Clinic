import type { PrismaClient } from '../generated/prisma/client.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigurationError } from './env.js';

const bilingual = z.strictObject({
  ru: z.string().trim().min(2).max(2000),
  kk: z.string().trim().min(2).max(2000),
});
export const clinicProfileSchema = z.strictObject({
  name: bilingual,
  address: bilingual,
  hours: bilingual,
  phone: z.string().regex(/^\+7\d{10}$/),
  email: z.email(),
  license: bilingual,
  privacy: bilingual,
  logoAsset: z
    .string()
    .regex(/^\/assets\/clinic\/[a-z0-9-]+\.(svg|png|webp)$/)
    .nullable(),
  timeZone: z.string().refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }),
  synthetic: z.boolean(),
});
export type ClinicProfile = z.infer<typeof clinicProfileSchema>;
export const demoProfile: ClinicProfile = {
  name: { ru: 'Alatau Clinic', kk: 'Alatau Clinic' },
  address: {
    ru: 'Вымышленная клиника: адрес не для посещения',
    kk: 'Ойдан шығарылған клиника: келуге арналмаған мекенжай',
  },
  hours: { ru: 'Пн–Пт 09:00–18:00 (демо)', kk: 'Дс–Жм 09:00–18:00 (демо)' },
  phone: '+70000000000',
  email: 'clinic@example.invalid',
  license: {
    ru: 'Синтетическая демонстрация, не лицензия',
    kk: 'Синтетикалық демонстрация, лицензия емес',
  },
  privacy: {
    ru: 'Только синтетические контакты. Реальные данные не использовать.',
    kk: 'Тек синтетикалық байланыс деректері. Нақты деректерді қолданбаңыз.',
  },
  logoAsset: null,
  timeZone: 'Asia/Almaty',
  synthetic: true,
};
export function loadClinicProfile(env: NodeJS.ProcessEnv): ClinicProfile {
  try {
    const profile = env.CLINIC_PROFILE_FILE
      ? clinicProfileSchema.parse(JSON.parse(readFileSync(env.CLINIC_PROFILE_FILE, 'utf8')))
      : demoProfile;
    if (profile.timeZone !== env.CLINIC_TIME_ZONE) throw new Error();
    if (env.DATA_MODE === 'clinic') {
      // Explicit operator activation artifact, not a legal certification by this program.
      const activation = z
        .strictObject({
          approved: z.literal(true),
          clinicName: z.string().min(2),
          decisionReference: z.string().min(3).max(200),
          decidedAt: z.iso.datetime({ offset: true }),
          phoneConsentApproved: z.boolean(),
          consentContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
          catalogueReviewed: z.boolean(),
        })
        .parse(JSON.parse(readFileSync(env.CLINIC_ACTIVATION_FILE ?? '', 'utf8')));
      if (
        profile.synthetic ||
        activation.clinicName !== profile.name.ru ||
        /example\.invalid$/.test(profile.email)
      )
        throw new Error();
    } else if (!profile.synthetic) throw new Error();
    return profile;
  } catch {
    throw new ConfigurationError(['CLINIC_PROFILE_FILE', 'CLINIC_ACTIVATION_FILE']);
  }
}
export function approvedConsentHash(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DATA_MODE !== 'clinic') return undefined;
  try {
    return z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(
        JSON.parse(readFileSync(env.CLINIC_ACTIVATION_FILE ?? '', 'utf8')).consentContentSha256,
      );
  } catch {
    throw new ConfigurationError(['CLINIC_ACTIVATION_FILE']);
  }
}
export function phoneConsentEnabled(env: NodeJS.ProcessEnv) {
  if (env.DATA_MODE !== 'clinic') return true;
  try {
    return (
      JSON.parse(readFileSync(env.CLINIC_ACTIVATION_FILE ?? '', 'utf8')).phoneConsentApproved ===
      true
    );
  } catch {
    return false;
  }
}
export function publicBookingEnabled(env: NodeJS.ProcessEnv) {
  if (env.DATA_MODE !== 'clinic') return true;
  try {
    return (
      JSON.parse(readFileSync(env.CLINIC_ACTIVATION_FILE ?? '', 'utf8')).catalogueReviewed === true
    );
  } catch {
    return false;
  }
}

export async function verifyClinicData(db: PrismaClient, env: NodeJS.ProcessEnv) {
  if (env.DATA_MODE !== 'clinic') return;
  const [doctors, services, seedDoctors, seedServices, seedStaff, consent] = await Promise.all([
    db.doctor.count({ where: { isActive: true } }),
    db.service.count({ where: { isActive: true } }),
    db.doctor.count({ where: { isActive: true, slug: { startsWith: 'synthetic-' } } }),
    db.service.count({ where: { isActive: true, slug: { startsWith: 'synthetic-' } } }),
    db.staffUser.count({ where: { isActive: true, email: { endsWith: '@example.invalid' } } }),
    db.consentDocument.findFirst({ where: { retiredAt: null, publishedAt: { lte: new Date() } } }),
  ]);
  if (
    seedDoctors ||
    seedServices ||
    seedStaff ||
    (publicBookingEnabled(env) && (!doctors || !services || !consent)) ||
    (consent &&
      (consent.contentSha256 !== approvedConsentHash(env) ||
        consent.version.startsWith('synthetic')))
  )
    throw new ConfigurationError(['CLINIC_DATA_ACTIVATION']);
}
