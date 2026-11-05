import { z } from 'zod/mini';
const text = z.string(),
  id = z.string();
export const serviceSchema = z.object({
  id,
  slug: text,
  nameRu: text,
  nameKk: text,
  descriptionRu: text,
  descriptionKk: text,
  priceKzt: text,
  durationMinutes: z.number(),
});
export const doctorSchema = z.object({
  id,
  slug: text,
  nameRu: text,
  nameKk: text,
  specialtyRu: text,
  specialtyKk: text,
  bioRu: text,
  bioKk: text,
  photoAssetKey: z.nullable(text),
  services: z.array(serviceSchema),
});
export type Service = z.infer<typeof serviceSchema>;
export type Doctor = z.infer<typeof doctorSchema>;
export const consentSchema = z.object({
  id,
  version: text,
  locale: text,
  text,
  contentSha256: text,
});
export const availabilitySchema = z.object({
  serviceId: id,
  priceKzt: text,
  durationMinutes: z.number(),
  timeZone: text,
  date: text,
  slots: z.array(z.object({ startsAt: text, endsAt: text })),
});
export const resultSchema = z.object({
  reference: text,
  status: text,
  doctorId: id,
  serviceId: id,
  startsAt: text,
  endsAt: text,
  priceKzt: text,
  durationMinutes: z.number(),
});
export type BookingResult = z.infer<typeof resultSchema>;
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 0);
  }
  if (!response.ok) {
    let code = 'API_ERROR';
    try {
      const value = z.object({ error: z.object({ code: text }) }).parse(await response.json());
      code = value.error.code;
    } catch {
      /* never expose an upstream body */
    }
    throw new ApiError(code, response.status);
  }
  return response.status === 204 ? null : (response.json() as Promise<unknown>);
}
export async function services(signal?: AbortSignal) {
  return allPages('/services', serviceSchema, signal);
}
export async function doctors(signal?: AbortSignal) {
  return allPages('/doctors', doctorSchema, signal);
}
async function allPages<T>(path: string, schema: z.ZodMiniType<T>, signal?: AbortSignal) {
  const output: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = z
      .object({ items: z.array(schema), pagination: z.object({ total: z.number() }) })
      .parse(await request(`${path}?page=${page}&pageSize=100`, signal ? { signal } : {}));
    output.push(...data.items);
    if (output.length >= data.pagination.total) return output;
  }
  throw new ApiError('CATALOG_TOO_LARGE', 503);
}
export function newKey() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function submitBooking(body: unknown, key: string) {
  const csrf = z.object({ csrfToken: text }).parse(await request('/auth/csrf'));
  return resultSchema.parse(
    await request('/appointments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf.csrfToken,
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    }),
  );
}
export function validateContacts(name: string, phone: string, accepted: boolean) {
  return (
    name.trim().length >= 2 &&
    name.trim().length <= 120 &&
    /^[\p{L}\p{M} '-]+$/u.test(name.trim()) &&
    /^\+7\d{10}$/.test(phone.replace(/[ ()-]/g, '')) &&
    accepted
  );
}
