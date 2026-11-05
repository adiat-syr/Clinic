import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import type { $ZodType } from 'zod/v4/core';
import { apiErrorSchema, healthResponseSchema } from '@clinic/contracts';
import * as catalog from '../src/modules/catalog/schemas.js';
import * as auth from '../src/modules/security/input.js';
import { auditMetadataSchema } from '../src/modules/security/audit.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const page = z.strictObject({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
const staff = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(['ADMIN', 'RECEPTIONIST']),
  isActive: z.boolean(),
  mfaEnabled: z.boolean(),
});
const audit = z.strictObject({
  id: z.uuid(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid().nullable(),
  actorUserId: z.uuid().nullable(),
  requestId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  metadata: auditMetadataSchema,
});
const definitions: Record<string, $ZodType> = {
  Error: apiErrorSchema,
  Health: healthResponseSchema,
  Login: auth.loginSchema,
  MfaCode: auth.mfaCodeSchema,
  PasswordChange: auth.passwordChangeSchema,
  Empty: z.strictObject({}),
  Csrf: z.strictObject({ csrfToken: z.string().regex(/^[0-9a-f]{64}$/) }),
  Challenge: z.strictObject({ mfaRequired: z.literal(true) }),
  Authenticated: z.strictObject({ authenticated: z.literal(true) }),
  Me: z.strictObject({ id: z.uuid(), email: z.email(), role: z.enum(['ADMIN', 'RECEPTIONIST']) }),
  DoctorCreate: catalog.doctorCreateSchema,
  DoctorPatch: catalog.doctorPatchSchema,
  ServiceCreate: catalog.serviceCreateSchema,
  ServicePatch: catalog.servicePatchSchema,
  PublicDoctor: catalog.publicDoctorSchema,
  AdminDoctor: catalog.adminDoctorSchema,
  PublicService: catalog.publicServiceSchema,
  AdminService: catalog.adminServiceSchema,
  AssignmentInput: catalog.assignmentSchema,
  Assignment: z.strictObject({ doctorId: z.uuid(), serviceId: z.uuid(), isActive: z.boolean() }),
  StaffCreate: auth.staffCreateSchema,
  StaffPatch: auth.staffPatchSchema,
  Staff: staff,
  Audit: audit,
};
const schemas: Record<string, unknown> = { Pagination: z.toJSONSchema(page) };
for (const [name, schema] of Object.entries(definitions)) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  delete json.$schema;
  if (['DoctorPatch', 'ServicePatch', 'StaffPatch'].includes(name)) json.minProperties = 1;
  for (const key of ['password', 'currentPassword', 'newPassword', 'code']) {
    const property = json.properties?.[key];
    if (property && typeof property === 'object') property.writeOnly = true;
  }
  schemas[name] = json;
}
for (const name of [
  'PublicDoctor',
  'AdminDoctor',
  'PublicService',
  'AdminService',
  'Staff',
  'Audit',
]) {
  schemas[`${name}Page`] = {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'pagination'],
    properties: { items: { type: 'array', items: ref(name) }, pagination: ref('Pagination') },
  };
}
const jsonResponse = (name: string, description = 'Success') => ({
  description,
  headers: {
    'Cache-Control': { schema: { type: 'string', const: 'no-store' } },
    'X-Request-Id': { schema: { type: 'string', format: 'uuid' } },
  },
  content: { 'application/json': { schema: ref(name) } },
});
function operation(
  method: string,
  id: string,
  summary: string,
  access: 'public' | 'session' | 'admin',
  response: string | null,
  body?: string,
  status = 200,
) {
  const mutation = !['get', 'head'].includes(method);
  const security: Record<string, string[]> = {};
  if (access !== 'public') security.SessionCookie = [];
  if (mutation) {
    security.CsrfHeader = [];
    security.CsrfNonce = [];
  }
  const responses: Record<string, unknown> = {
    [status]: response
      ? jsonResponse(response)
      : { description: 'Completed; session cookie is cleared for logout/password change' },
  };
  for (const code of [400, 401, 403, 404, 409, 413, 429, 500, 503])
    responses[code] = jsonResponse(
      'Error',
      'Safe error: code, message, requestId; no stack/SQL/input values',
    );
  return {
    operationId: id,
    summary,
    description: `${access === 'admin' ? 'ADMIN and fully verified MFA session required. ' : access === 'session' ? 'Session required; MFA verification accepts a CHALLENGE session only. ' : ''}Unknown query/body fields are rejected. All responses use no-store.`,
    security: Object.keys(security).length ? [security] : [],
    ...(mutation
      ? {
          parameters: [
            {
              in: 'header',
              name: 'Origin',
              required: true,
              description: 'Must exactly match configured AUTH_ORIGIN.',
              schema: { type: 'string', format: 'uri' },
            },
          ],
        }
      : {}),
    ...(body
      ? {
          requestBody: {
            required: body !== 'Empty',
            content: { 'application/json': { schema: ref(body) } },
          },
        }
      : {}),
    responses,
  };
}
const pagination = [
  {
    name: 'page',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
  },
  {
    name: 'pageSize',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
];
const pathParameter = (name: string, uuid = true) => ({
  name,
  in: 'path',
  required: true,
  schema: uuid
    ? { type: 'string', format: 'uuid' }
    : { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100 },
});
const paths: Record<string, unknown> = {
  '/health/live': { get: operation('get', 'liveness', 'Process liveness', 'public', 'Health') },
  '/health/ready': { get: operation('get', 'readiness', 'Database readiness', 'public', 'Health') },
  '/auth/csrf': {
    get: operation(
      'get',
      'csrf',
      'Issue nonce cookie and session-bound CSRF header value',
      'public',
      'Csrf',
    ),
  },
  '/auth/login': {
    post: operation(
      'post',
      'login',
      'Verify password and issue five-minute CHALLENGE cookie',
      'public',
      'Challenge',
      'Login',
    ),
  },
  '/auth/mfa/verify': {
    post: operation(
      'post',
      'verifyMfa',
      'Consume TOTP code once, rotate cookie, authenticate',
      'session',
      'Authenticated',
      'MfaCode',
    ),
  },
  '/auth/me': {
    get: operation('get', 'me', 'Current fully authenticated staff identity', 'session', 'Me'),
  },
  '/auth/logout': {
    post: operation(
      'post',
      'logout',
      'Revoke authenticated or challenge session',
      'session',
      null,
      'Empty',
      204,
    ),
  },
  '/auth/password': {
    post: operation(
      'post',
      'password',
      'Change own password and revoke all own sessions',
      'session',
      null,
      'PasswordChange',
      204,
    ),
  },
};
for (const [plural, singular] of [
  ['doctors', 'Doctor'],
  ['services', 'Service'],
]) {
  paths[`/${plural}`] = {
    get: {
      ...operation(
        'get',
        `listPublic${singular}`,
        `Active ${plural}`,
        'public',
        `Public${singular}Page`,
      ),
      parameters: pagination,
    },
  };
  paths[`/${plural}/{slug}`] = {
    parameters: [pathParameter('slug', false)],
    get: operation(
      'get',
      `getPublic${singular}`,
      `Active ${singular} by slug`,
      'public',
      `Public${singular}`,
    ),
  };
  paths[`/admin/${plural}`] = {
    get: {
      ...operation(
        'get',
        `listAdmin${singular}`,
        `All ${plural}, including inactive`,
        'admin',
        `Admin${singular}Page`,
      ),
      parameters: pagination,
    },
    post: operation(
      'post',
      `create${singular}`,
      `Create ${singular}`,
      'admin',
      `Admin${singular}`,
      `${singular}Create`,
      201,
    ),
  };
  paths[`/admin/${plural}/{id}`] = {
    parameters: [pathParameter('id')],
    get: operation(
      'get',
      `getAdmin${singular}`,
      `${singular} by UUID`,
      'admin',
      `Admin${singular}`,
    ),
    patch: operation(
      'patch',
      `patch${singular}`,
      `Edit or deactivate ${singular}; slug is immutable`,
      'admin',
      `Admin${singular}`,
      `${singular}Patch`,
    ),
  };
}
paths['/admin/doctors/{id}/services/{serviceId}'] = {
  parameters: [pathParameter('id'), pathParameter('serviceId')],
  put: operation(
    'put',
    'assignService',
    'Assign/reactivate/deactivate doctor–service relationship',
    'admin',
    'Assignment',
    'AssignmentInput',
  ),
};
paths['/admin/staff'] = {
  get: {
    ...operation(
      'get',
      'listStaff',
      'Audited staff list without credentials',
      'admin',
      'StaffPage',
    ),
    parameters: pagination,
  },
  post: operation(
    'post',
    'createStaff',
    'Create inactive account; credentials are provisioned offline',
    'admin',
    'Staff',
    'StaffCreate',
    201,
  ),
};
paths['/admin/staff/{id}'] = {
  parameters: [pathParameter('id')],
  get: operation('get', 'getStaff', 'Audited staff identity without credentials', 'admin', 'Staff'),
  patch: operation(
    'patch',
    'patchStaff',
    'Change role or block/unblock; preserve last ADMIN',
    'admin',
    'Staff',
    'StaffPatch',
  ),
};
paths['/admin/staff/{id}/revoke-sessions'] = {
  parameters: [pathParameter('id')],
  post: operation(
    'post',
    'revokeSessions',
    'Revoke all target sessions',
    'admin',
    null,
    'Empty',
    204,
  ),
};
paths['/admin/audit-events'] = {
  get: {
    ...operation(
      'get',
      'listAudit',
      'Audited paginated technical events; no PII values',
      'admin',
      'AuditPage',
    ),
    parameters: [
      ...pagination,
      ...['from', 'to'].map((name) => ({
        name,
        in: 'query',
        description: 'ISO instant; default last seven days, maximum span 31 days.',
        schema: { type: 'string', format: 'date-time' },
      })),
    ],
  },
};
const document = {
  openapi: '3.1.0',
  info: {
    title: 'Clinic API — stage 3',
    version: '0.3.0',
    description:
      'Synthetic local implementation. No booking/schedule HTTP API or admin UI. HTTPS production uses __Host cookies; loopback HTTP development uses clinic_dev_session and clinic_dev_csrf. Fetch CSRF again after login/MFA token rotation. All mutations require exact Origin plus CSRF nonce cookie/header. MFA is mandatory for both roles. See AUTH.md for TTLs, rate limits and CLI operations.',
  },
  servers: [{ url: '/api/v1' }],
  paths,
  components: {
    schemas,
    securitySchemes: {
      SessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-clinic_session',
        description:
          'HttpOnly Secure SameSite=Lax Path=/; opaque random token, never returned in JSON. TTL challenge 5m; authenticated 8h, idle 30m.',
      },
      CsrfNonce: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Host-clinic_csrf',
        description: 'HttpOnly Secure nonce cookie from GET /auth/csrf.',
      },
      CsrfHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'X-CSRF-Token',
        description: 'Session-bound HMAC value returned by GET /auth/csrf.',
      },
    },
  },
};
const destination = new URL('../../../docs/openapi.json', import.meta.url);
const output = await format(JSON.stringify(document), {
  ...(await resolveConfig(fileURLToPath(destination))),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')) !== output)
    throw new Error('OpenAPI is stale; run npm run openapi:generate');
  console.log('OpenAPI matches the Zod contracts and stage 3 operation definitions.');
} else {
  await writeFile(destination, output);
  console.log('Updated docs/openapi.json.');
}
