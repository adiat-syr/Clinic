import { z } from 'zod';
import { price } from '../booking/input.js';

const name = z.string().trim().min(1).max(120);
const text = z.string().max(10000);
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
const photo = z
  .string()
  .regex(/^doctors\/[a-z0-9-]+\.(?:webp|avif|png|jpg)$/)
  .nullable();
const doctorFields = {
  nameRu: name,
  nameKk: name,
  specialtyRu: name,
  specialtyKk: name,
  bioRu: text,
  bioKk: text,
  photoAssetKey: photo,
};
const serviceFields = {
  nameRu: name,
  nameKk: name,
  descriptionRu: text,
  descriptionKk: text,
  durationMinutes: z.number().int().min(1).max(1440),
  priceKzt: price,
};
export const doctorCreateSchema = z.strictObject({
  slug,
  ...doctorFields,
  isActive: z.boolean().default(true),
});
export const doctorPatchSchema = z
  .strictObject({ ...doctorFields, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export const serviceCreateSchema = z.strictObject({
  slug,
  ...serviceFields,
  isActive: z.boolean().default(true),
});
export const servicePatchSchema = z
  .strictObject({ ...serviceFields, isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export const assignmentSchema = z.strictObject({ isActive: z.boolean() });
export const publicServiceSchema = z.strictObject({ id: z.uuid(), slug, ...serviceFields });
export const adminServiceSchema = publicServiceSchema.extend({ isActive: z.boolean() });
export const publicDoctorSchema = z.strictObject({
  id: z.uuid(),
  slug,
  ...doctorFields,
  services: z.array(publicServiceSchema),
});
export const adminDoctorSchema = z.strictObject({
  id: z.uuid(),
  slug,
  ...doctorFields,
  isActive: z.boolean(),
  services: z.array(z.strictObject({ isActive: z.boolean(), service: adminServiceSchema })),
});
export const publicSlugSchema = slug;
