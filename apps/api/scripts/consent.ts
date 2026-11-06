import { loadSecretFiles } from '../src/config/secrets.js';
import { readFile } from 'node:fs/promises';
import { parseEnvironment } from '../src/config/env.js';
import { parsePrivacyEnvironment } from '../src/modules/booking/privacy.js';
import { BookingHttpService } from '../src/modules/booking/http-service.js';
import { createPrisma } from '../src/infrastructure/prisma.js';
if (process.argv.length !== 3 || !process.argv[2])
  throw new Error('Usage: consent:publish <local consent JSON file>');
loadSecretFiles();
const client = createPrisma(parseEnvironment(process.env).DATABASE_URL);
try {
  const text = await readFile(process.argv[2], 'utf8');
  if (Buffer.byteLength(text) > 200000) throw new Error();
  const service = new BookingHttpService(client, parsePrivacyEnvironment(process.env));
  const result = await service.publish(JSON.parse(text));
  console.log(JSON.stringify(result));
} catch {
  console.error('Consent publication failed; input was not logged.');
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
