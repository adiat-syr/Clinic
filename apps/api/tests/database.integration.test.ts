import { afterAll, describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/config/env.js';
import { createDatabase } from '../src/infrastructure/database.js';

const config = parseEnvironment(process.env);
if (
  config.DATABASE_URL !== process.env.TEST_DATABASE_URL ||
  !/^\/clinic_test_[a-f0-9]{32}$/.test(new URL(config.DATABASE_URL).pathname)
) {
  throw new Error('Use the disposable integration database runner');
}
const database = createDatabase(config.DATABASE_URL);

afterAll(() => database.close());

describe('real local PostgreSQL', () => {
  it('accepts a connection and provides the extension required by stage 2', async () => {
    await database.ping();
    const result = await database.inspect();
    expect(result.version).toMatch(/^18\.6(?:\s|$)/);
    expect(result.extensionAvailable).toBe(true);
  });
});
