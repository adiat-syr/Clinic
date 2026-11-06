import { database, secret, run, identifier, log } from './lib.mjs';

const roles = [
  'clinic_migrator',
  'clinic_runtime',
  'clinic_operator',
  'clinic_maintenance',
  'clinic_backup',
];
export async function bootstrap() {
  const pool = await database('BOOTSTRAP_DATABASE_URL'),
    db = await pool.connect();
  try {
    await db.query("SET log_min_error_statement='panic'");
    await db.query("SET log_error_verbosity='terse'");
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(75004,1)');
    const passwords = JSON.parse(await secret('ROLE_PASSWORDS'));
    for (const role of roles) {
      if (typeof passwords[role] !== 'string' || passwords[role].length < 32)
        throw new Error('INVALID_ROLE_SECRET');
      if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) {
        const sql = await db.query(
          "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text)",
          [role, passwords[role]],
        );
        await db.query(sql.rows[0].format);
      }
    }
    const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
    await db.query(`REVOKE ALL ON DATABASE ${identifier(name)} FROM PUBLIC`);
    await db.query(
      `GRANT CONNECT ON DATABASE ${identifier(name)} TO ${roles.map(identifier).join(',')}`,
    );
    await db.query(`GRANT CREATE ON DATABASE ${identifier(name)} TO clinic_migrator`);
    await db.query('ALTER SCHEMA public OWNER TO clinic_migrator');
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query('COMMIT');
    log('database_roles_bootstrapped');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
}
export async function migrate() {
  const url = await secret('MIGRATION_DATABASE_URL');
  await run(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      'apps/api/prisma.config.ts',
    ],
    { ...process.env, DATABASE_URL: url },
  );
  log('migration_deployed');
}
export async function grants() {
  const pool = await database('MIGRATION_DATABASE_URL'),
    db = await pool.connect();
  try {
    await db.query('BEGIN');
    await applyGrants(db);
    await db.query('COMMIT');
    log('database_grants_applied');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
}

export async function applyGrants(db) {
  await db.query(
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,clinic_runtime,clinic_operator,clinic_maintenance,clinic_backup',
  );
  await db.query(
    'GRANT USAGE ON SCHEMA public TO clinic_runtime,clinic_operator,clinic_maintenance,clinic_backup',
  );
  await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO clinic_backup');
  await db.query(
    'GRANT SELECT ON doctors,services,doctor_services,consent_documents,appointments,appointment_consents,idempotency_keys,staff_users,staff_sessions,rate_limit_buckets,audit_events,patient_consent_receipts TO clinic_runtime',
  );
  await db.query(
    'GRANT INSERT,UPDATE ON doctors,services,doctor_services,appointments,appointment_consents,idempotency_keys,staff_users,staff_sessions,rate_limit_buckets TO clinic_runtime',
  );
  await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON availability_windows TO clinic_runtime');
  await db.query('GRANT INSERT ON audit_events,patient_consent_receipts TO clinic_runtime');
  // FOR SHARE needs UPDATE on a column. Published ID is guarded immutable.
  await db.query('GRANT UPDATE(id) ON consent_documents TO clinic_runtime');
  await db.query(
    'GRANT UPDATE(consumed_at,appointment_id) ON patient_consent_receipts TO clinic_runtime',
  );
  await db.query(
    'GRANT SELECT,INSERT,UPDATE ON staff_users,staff_sessions,bootstrap_state,consent_documents TO clinic_operator',
  );
  await db.query('GRANT SELECT,INSERT ON audit_events TO clinic_operator');
  await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO clinic_maintenance');
  await db.query('GRANT UPDATE(updated_at) ON doctors,services TO clinic_maintenance');
  await db.query('GRANT UPDATE(withdrawn_at) ON appointment_consents TO clinic_maintenance');
  await db.query(
    'GRANT DELETE ON staff_sessions,rate_limit_buckets,idempotency_keys,patient_consent_receipts TO clinic_maintenance',
  );
  await db.query(
    'GRANT UPDATE(patient_name_ciphertext,phone_ciphertext,encryption_key_version,anonymized_at,updated_at,version) ON appointments TO clinic_maintenance',
  );
  await db.query(
    'GRANT UPDATE(patient_name_ciphertext,phone_ciphertext,encryption_key_version) ON patient_consent_receipts TO clinic_maintenance',
  );
  await db.query('GRANT UPDATE(mfa_secret_ciphertext) ON staff_users TO clinic_maintenance');
  await db.query('GRANT SELECT,INSERT ON audit_events TO clinic_maintenance');
  await db.query('GRANT UPDATE ON staff_sessions TO clinic_maintenance');
}
