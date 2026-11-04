import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function createPrisma(connectionString: string) {
  const adapter = new PrismaPg(
    {
      connectionString,
      max: 20,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      application_name: 'clinic-domain',
    },
    { onPoolError: () => {}, onConnectionError: () => {} },
  );
  return new PrismaClient({ adapter, log: [], errorFormat: 'minimal' });
}
