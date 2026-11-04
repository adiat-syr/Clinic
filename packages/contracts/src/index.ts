import * as z from 'zod/mini';

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'ready']),
  service: z.literal('clinic-api'),
  dataMode: z.literal('synthetic'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().check(z.minLength(1), z.maxLength(64)),
    message: z.string().check(z.minLength(1)),
    requestId: z.uuid(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
