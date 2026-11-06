import { z } from 'zod';
import { BookingError } from './errors.js';

export const uuid = z.uuid().transform((value) => value.toLowerCase());
export const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
export const price = z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/);
const ciphertext = z
  .instanceof(Uint8Array)
  .refine((value) => value.length >= 30 && value.length <= 2048)
  .transform((value) => new Uint8Array(value));

// Trusted server-side privacy boundary, NOT an HTTP DTO. Never expose fingerprint to a client.
export const sealedContactsSchema = z.strictObject({
  patientNameCiphertext: ciphertext,
  phoneCiphertext: ciphertext,
  encryptionKeyVersion: z.string().min(1).max(80),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SealedContacts = z.infer<typeof sealedContactsSchema>;

export const selectionSchema = z.strictObject({
  doctorId: uuid,
  serviceId: uuid,
  startsAt: instant,
  expectedPriceKzt: price,
  expectedDurationMinutes: z.number().int().min(1).max(1440),
});
export const bookingSchema = selectionSchema.extend({
  idempotencyKey: z.string().regex(/^[0-9a-fA-F]{32,128}$/),
  contacts: sealedContactsSchema,
  consent: z.strictObject({
    documentId: uuid,
    accepted: z.literal(true),
    locale: z.enum(['ru', 'kk']),
    receiptHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
});
export const moveSchema = selectionSchema.extend({
  appointmentId: uuid,
  version: z.number().int().positive(),
});
export const windowSchema = z.strictObject({ doctorId: uuid, startsAt: instant, endsAt: instant });
export const rangeSchema = z.strictObject({
  doctorId: uuid,
  serviceId: uuid,
  from: instant,
  to: instant,
});
export const transitionSchema = z.strictObject({
  appointmentId: uuid,
  version: z.number().int().positive(),
  status: z.enum(['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
});
export const serviceChangeSchema = z.strictObject({
  serviceId: uuid,
  priceKzt: price.optional(),
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  isActive: z.boolean().optional(),
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BookingError('INVALID_INPUT');
  return result.data;
}
