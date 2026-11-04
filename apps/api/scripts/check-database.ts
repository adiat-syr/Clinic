import { parseEnvironment } from '../src/config/env.js';
import { createDatabase } from '../src/infrastructure/database.js';

const config = parseEnvironment(process.env);
const database = createDatabase(config.DATABASE_URL);

try {
  await database.ping();
  const result = await database.inspect();
  if (!result.extensionAvailable) throw new Error('Required extension is not available');
  console.log(`PostgreSQL ${result.version}: connection OK; btree_gist available.`);
  console.log(
    'This diagnostic performed read-only queries; it does not apply migrations or seed data.',
  );
} catch {
  console.error(
    'Database check failed. Check local PostgreSQL and .env; credentials are not printed.',
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
