import { z } from 'zod';
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const newPasswordSchema = z
  .string()
  .min(16)
  .max(128)
  .refine((value) =>
    [...value].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127;
    }),
  );
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const mfaCodeSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
export const passwordChangeSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordSchema,
});
export const staffCreateSchema = z.strictObject({
  email: emailSchema,
  role: z.enum(['ADMIN', 'RECEPTIONIST']),
});
export const staffPatchSchema = z
  .strictObject({
    role: z.enum(['ADMIN', 'RECEPTIONIST']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined));
export const credentialsSchema = z.strictObject({
  email: emailSchema,
  password: newPasswordSchema,
  mfaSecret: z.string().regex(/^[A-Z2-7]{32,128}$/),
  code: z.string().regex(/^\d{6}$/),
});
export const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
export const paginationSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
