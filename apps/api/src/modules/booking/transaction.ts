import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { BookingError, databaseErrorFacts, translateDatabaseError } from './errors.js';

export type Transaction = Prisma.TransactionClient;

export async function withTransaction<T>(
  client: PrismaClient,
  work: (tx: Transaction) => Promise<T>,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true)`;
          await tx.$queryRaw`SELECT set_config('statement_timeout', '6s', true)`;
          return work(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 15_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      const { codes } = databaseErrorFacts(error);
      const retryable = ['P2034', '40001', '40P01', '55P03', 'TransactionWriteConflict'].some(
        (code) => codes.has(code),
      );
      if (!retryable) throw translateDatabaseError(error);
      if (attempt === 2) throw new BookingError('CONCURRENCY_RETRY_EXHAUSTED');
      await delay(10 * (attempt + 1));
    }
  }
  throw new BookingError('CONCURRENCY_RETRY_EXHAUSTED');
}
