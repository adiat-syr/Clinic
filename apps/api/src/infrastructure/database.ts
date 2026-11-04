import pg from 'pg';

// Read-only health diagnostics. Domain operations use the Prisma factory in prisma.ts.
export function createDatabase(connectionString: string, onPoolError: () => void = () => {}) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 3_000,
    query_timeout: 3_500,
    application_name: 'clinic-foundation',
  });
  pool.on('error', onPoolError);

  return {
    async ping(): Promise<void> {
      await pool.query('SELECT 1');
    },
    async inspect(): Promise<{ version: string; extensionAvailable: boolean }> {
      const version = await pool.query<{ server_version: string }>('SHOW server_version');
      const extension = await pool.query<{ name: string }>(
        'SELECT name FROM pg_available_extensions WHERE name = $1',
        ['btree_gist'],
      );
      return {
        version: version.rows[0]?.server_version ?? 'unknown',
        extensionAvailable: extension.rowCount === 1,
      };
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export type Database = ReturnType<typeof createDatabase>;
