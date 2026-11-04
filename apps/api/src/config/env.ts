import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATA_MODE: z.literal('synthetic'),
  API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return ['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname.length > 1;
    } catch {
      return false;
    }
  }),
  CLINIC_TIME_ZONE: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat('ru-KZ', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
});

export class ConfigurationError extends Error {
  constructor(readonly fields: string[]) {
    super(`Invalid environment fields: ${fields.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export function parseEnvironment(environment: NodeJS.ProcessEnv) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new ConfigurationError([
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ]);
  }
  return result.data;
}
