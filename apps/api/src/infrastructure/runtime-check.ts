import type { PrismaClient } from '../generated/prisma/client.js';

export async function verifyRuntimeDatabase(db: PrismaClient) {
  const rows = await db.$queryRaw<{ version: string; unsafe: boolean; exclusions: bigint }[]>`
    SELECT current_setting('server_version') AS version,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication OR
       has_database_privilege(current_user,current_database(),'CREATE') OR
       EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR
       has_schema_privilege(current_user,'public','CREATE') OR
       EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid)) AS unsafe,
      (SELECT count(*) FROM pg_constraint WHERE conname IN ('appointments_no_overlap','availability_no_overlap')) AS exclusions
    FROM pg_roles r WHERE r.rolname=current_user`;
  const row = rows[0];
  if (!row || !/^18\.6(?:\s|$)/.test(row.version) || row.unsafe || row.exclusions !== 2n)
    throw new Error('Unsafe production database configuration');
}
