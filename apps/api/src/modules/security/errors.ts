import { z } from 'zod';

export class AccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'AccessError';
  }
}
export function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AccessError(400, 'INVALID_INPUT');
  return result.data;
}
