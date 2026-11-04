import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --env-file-if-exists=../../.env --import tsx prisma/seed.ts',
  },
  datasource: { url: env('DATABASE_URL') },
});
