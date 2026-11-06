import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export function createPrisma(connectionString: string, maxConnections = 20) {
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 200)
    throw new Error('Invalid pool size');
  const adapter = new PrismaPg(
    {
      connectionString,
      max: maxConnections,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      application_name: 'clinic-domain',
    },
    { onPoolError: () => {}, onConnectionError: () => {} },
  );
  return new PrismaClient({ adapter, log: [], errorFormat: 'minimal' });
}
