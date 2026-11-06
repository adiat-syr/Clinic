import { z } from 'zod';
import {
  publicBookingSchema,
  appointmentCommand,
  withdrawalSchema,
  windowSchema,
  patientConsentSchema,
  staffBookingSchema,
} from '../src/modules/booking/http-service.js';
export function bookingOpenApi() {
  const schemas: Record<string, unknown> = {};
  for (const [name, value] of Object.entries({
    BookingInput: publicBookingSchema,
    AppointmentCommand: appointmentCommand,
    WithdrawalInput: withdrawalSchema,
    WindowInput: windowSchema,
    PatientConsentInput: patientConsentSchema,
    StaffBookingInput: staffBookingSchema,
  })) {
    const s = z.toJSONSchema(value, { io: 'input' });
    delete s.$schema;
    schemas[name] = s;
  }
  const id = z.uuid(),
    instant = z.iso.datetime({ offset: true }),
    status = z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']);
  const fields = {
    reference: id,
    status,
    doctorId: id,
    serviceId: id,
    startsAt: instant,
    endsAt: instant,
    priceKzt: z.string(),
    durationMinutes: z.number().int(),
  };
  schemas.PatientConsentCode = {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'expiresAt', 'documentVersion'],
    properties: {
      code: { type: 'string', pattern: '^[a-f0-9]{32}$' },
      expiresAt: { type: 'string', format: 'date-time' },
      documentVersion: { type: 'string' },
    },
  };
  const publicResult = z.strictObject(fields),
    summary = z.strictObject({
      ...fields,
      id,
      version: z.number().int(),
      doctorNameRu: z.string().optional(),
      doctorNameKk: z.string().optional(),
      serviceNameRu: z.string().optional(),
      serviceNameKk: z.string().optional(),
    });
  const pagination = z.strictObject({ page: z.number(), pageSize: z.number(), total: z.number() });
  const window = z.strictObject({
    id,
    doctorId: id,
    startsAt: instant,
    endsAt: instant,
    updatedAt: instant,
  });
  const detail = summary.extend({
    contacts: z.strictObject({ name: z.string(), phone: z.string() }).nullable(),
    consent: z
      .strictObject({ documentId: id, acceptedAt: instant, withdrawnAt: instant.nullable() })
      .nullable(),
  });
  for (const [name, value] of Object.entries({
    BookingResult: publicResult,
    AppointmentSummary: summary,
    AppointmentDetail: detail,
    AppointmentPage: z.strictObject({ items: z.array(summary), pagination }),
    WindowResult: window,
    WindowPage: z.strictObject({ items: z.array(window), pagination }),
    AvailabilityResult: z.strictObject({
      serviceId: id,
      priceKzt: z.string(),
      durationMinutes: z.number(),
      slots: z.array(z.strictObject({ startsAt: instant, endsAt: instant })),
      timeZone: z.string(),
      date: z.iso.date(),
    }),
    ConsentResult: z.strictObject({
      id,
      version: z.string(),
      locale: z.enum(['ru', 'kk']),
      text: z.string(),
      contentSha256: z.string(),
    }),
    WithdrawalResult: z.strictObject({ recorded: z.literal(true), version: z.number() }),
  })) {
    const s = z.toJSONSchema(value);
    delete s.$schema;
    schemas[name] = s;
  }
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (name: string) => ({
    description: 'Success; no-store',
    content: { 'application/json': { schema: ref(name) } },
  });
  const param = (name: string, schema: object, where = 'query', required = true) => ({
    name,
    in: where,
    required,
    schema,
  });
  const range = [
    param('from', { type: 'string', format: 'date-time' }),
    param('to', { type: 'string', format: 'date-time' }),
    param('doctorId', { type: 'string', format: 'uuid' }, 'query', false),
    param('page', { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, 'query', false),
    param('pageSize', { type: 'integer', minimum: 1, maximum: 100, default: 20 }, 'query', false),
  ];
  const pathId = param('id', { type: 'string', format: 'uuid' }, 'path');
  function op(
    operationId: string,
    method: string,
    out: string | null,
    body?: string,
    roles: string[] = [],
    parameters: object[] = [],
    code = 200,
  ) {
    const mutating = method !== 'get',
      security: Record<string, string[]> = {};
    if (roles.length) security.SessionCookie = [];
    if (mutating) {
      security.CsrfHeader = [];
      security.CsrfNonce = [];
      parameters = [...parameters, param('Origin', { type: 'string' }, 'header')];
    }
    const responses: Record<string, unknown> = {
      [code]: out ? response(out) : { description: 'Completed' },
    };
    for (const c of [400, 401, 403, 404, 409, 413, 429, 500, 503]) responses[c] = response('Error');
    if (operationId === 'createAppointment' || operationId === 'createStaffAppointment')
      responses[200] = response('BookingResult');
    return {
      operationId,
      description: `${roles.length ? roles.join(' or ') + ' with full MFA. ' : ''}Strict DTO/query fields; no-store; range ≤31 days. Public booking requires Idempotency-Key; callbacks use existing transactional core.`,
      security: Object.keys(security).length ? [security] : [],
      parameters,
      ...(body
        ? {
            requestBody: { required: true, content: { 'application/json': { schema: ref(body) } } },
          }
        : {}),
      responses,
    };
  }
  const staff = ['ADMIN', 'RECEPTIONIST'];
  const paths = {
    '/patient-consent-codes': {
      post: op(
        'issuePatientConsentCode',
        'post',
        'PatientConsentCode',
        'PatientConsentInput',
        [],
        [],
        201,
      ),
    },
    '/appointments': {
      post: op(
        'createAppointment',
        'post',
        'BookingResult',
        'BookingInput',
        [],
        [param('Idempotency-Key', { type: 'string', pattern: '^[a-fA-F0-9]{32,128}$' }, 'header')],
        201,
      ),
    },
    '/availability': {
      get: op(
        'getAvailability',
        'get',
        'AvailabilityResult',
        undefined,
        [],
        [
          param('doctorId', { type: 'string', format: 'uuid' }),
          param('serviceId', { type: 'string', format: 'uuid' }),
          param('date', { type: 'string', format: 'date' }),
        ],
      ),
    },
    '/consent-documents/current': {
      get: op(
        'currentConsent',
        'get',
        'ConsentResult',
        undefined,
        [],
        [param('locale', { type: 'string', enum: ['ru', 'kk'] })],
      ),
    },
    '/admin/appointments': {
      post: op(
        'createStaffAppointment',
        'post',
        'BookingResult',
        'StaffBookingInput',
        staff,
        [param('Idempotency-Key', { type: 'string', pattern: '^[a-fA-F0-9]{32,128}$' }, 'header')],
        201,
      ),
      get: op('listAppointments', 'get', 'AppointmentPage', undefined, staff, [
        ...range,
        param(
          'status',
          { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] },
          'query',
          false,
        ),
      ]),
    },
    '/admin/appointments/{id}': {
      get: op('appointmentDetail', 'get', 'AppointmentDetail', undefined, staff, [pathId]),
      patch: op('changeAppointment', 'patch', 'AppointmentSummary', 'AppointmentCommand', staff, [
        pathId,
      ]),
    },
    '/admin/appointments/{id}/consent-withdrawal': {
      post: op(
        'recordWithdrawal',
        'post',
        'WithdrawalResult',
        'WithdrawalInput',
        ['ADMIN'],
        [pathId],
      ),
    },
    '/admin/availability-windows': {
      get: op('listWindows', 'get', 'WindowPage', undefined, staff, range),
      post: op('createWindow', 'post', 'WindowResult', 'WindowInput', staff, [], 201),
    },
    '/admin/availability-windows/{id}': {
      patch: op('replaceWindow', 'patch', null, 'WindowInput', staff, [pathId], 204),
      delete: op('deleteWindow', 'delete', null, undefined, staff, [pathId], 204),
    },
  };
  return { schemas, paths };
}
