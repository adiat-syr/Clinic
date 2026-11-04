import { parseEnvironment } from '../src/config/env.js';
import { createPrisma } from '../src/infrastructure/prisma.js';
import { seedSyntheticClinic } from '../src/testing/synthetic-clinic.js';

const config = parseEnvironment(process.env);
const url = new URL(config.DATABASE_URL);
if (
  config.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
) {
  throw new Error('Synthetic seed is restricted to local development/test');
}
const client = createPrisma(config.DATABASE_URL);
try {
  const now = new Date();
  const day = new Date(now);
  day.setUTCDate(day.getUTCDate() + 1);
  await seedSyntheticClinic(client, day, now);
  console.log(
    'Synthetic clinic ready: 2 doctors, 3 services, 6 assignments, 4 working intervals, test consent, disabled staff.',
  );
  console.log(
    'No patients, bookings or usable administrator password seeded. Existing fixtures were preserved.',
  );
} finally {
  await client.$disconnect();
}
