import { translate as t, adminLocale } from './i18n';
import { z } from 'zod/mini';
import { request, ApiError, serviceSchema, doctorSchema } from '../api/clinic';
export const identitySchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['ADMIN', 'RECEPTIONIST']),
});
export type Identity = z.infer<typeof identitySchema>;
export const staffSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['ADMIN', 'RECEPTIONIST']),
  isActive: z.boolean(),
  mfaEnabled: z.boolean(),
});
export const adminService = z.object({ ...serviceSchema.shape, isActive: z.boolean() });
export const adminDoctor = z.object({
  ...doctorSchema.shape,
  isActive: z.boolean(),
  services: z.array(z.object({ isActive: z.boolean(), service: adminService })),
});
export const appointmentSchema = z.object({
  id: z.string(),
  reference: z.string(),
  doctorId: z.string(),
  serviceId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
  version: z.number(),
  priceKzt: z.string(),
  durationMinutes: z.number(),
  doctorNameRu: z.optional(z.string()),
  doctorNameKk: z.optional(z.string()),
  serviceNameRu: z.optional(z.string()),
  serviceNameKk: z.optional(z.string()),
});
export const detailSchema = z.object({
  ...appointmentSchema.shape,
  contacts: z.nullable(z.object({ name: z.string(), phone: z.string() })),
  consent: z.nullable(
    z.object({
      documentId: z.string(),
      acceptedAt: z.string(),
      withdrawnAt: z.nullable(z.string()),
    }),
  ),
});
export const windowSchema = z.object({
  id: z.string(),
  doctorId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  updatedAt: z.string(),
});
export const auditSchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.nullable(z.string()),
  actorUserId: z.nullable(z.string()),
  requestId: z.string(),
  createdAt: z.string(),
  metadata: z.object({ fields: z.optional(z.array(z.string())) }),
});
export const pageSchema = <T>(schema: z.ZodMiniType<T>) =>
  z.object({
    items: z.array(schema),
    pagination: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
  });
export async function adminRequest(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
) {
  try {
    const headers: Record<string, string> = { ...extraHeaders };
    if (method !== 'GET') {
      const csrf = z.object({ csrfToken: z.string() }).parse(await request('/auth/csrf'));
      headers['x-csrf-token'] = csrf.csrfToken;
      headers['content-type'] = 'application/json';
    }
    return await request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 401 &&
      !(path === '/auth/password' && error.code === 'LOGIN_FAILED') &&
      !['/auth/login', '/auth/mfa/verify', '/auth/me'].includes(path)
    )
      window.dispatchEvent(new Event('clinic-session-expired'));
    throw error;
  }
}
export function message(error: unknown) {
  if (!(error instanceof ApiError))
    return t('Не удалось выполнить запрос. Повторите после проверки соединения.');
  const messages: Record<string, string> = {
    CONSENT_CODE_UNAVAILABLE: t(
      'Код недействителен, истёк или уже использован. Нужен новый код пациента.',
    ),
    CONSENT_CHANGED: t('Версия согласия изменилась. Пациент должен подтвердить новую версию.'),
    IDEMPOTENCY_CONFLICT: t('Попытка уже отправлялась с другими данными. Обновите форму.'),
    LOGIN_FAILED: t('Неверные данные входа или доступ отключён.'),
    INVALID_MFA: t('Неверный или уже использованный код. Дождитесь нового кода.'),
    UNAUTHORIZED: t('Сессия истекла. Войдите заново.'),
    FORBIDDEN: t('Недостаточно прав для операции.'),
    CSRF_FAILED: t('Не удалось проверить запрос. Обновите страницу и повторите.'),
    RATE_LIMITED: t('Лимит запросов. Подождите перед повтором.'),
    SLOT_UNAVAILABLE: t('Это время уже занято. Исходная запись сохранена.'),
    VERSION_CONFLICT: t('Запись изменена другим сотрудником. Обновите карточку.'),
    SCHEDULE_HAS_APPOINTMENTS: t(
      'Изменение оставит приёмы вне расписания. Сначала перенесите или отмените их.',
    ),
    SCHEDULE_OVERLAP: t('Рабочие интервалы пересекаются.'),
    LAST_ADMIN_REQUIRED: t('Нельзя отключить или понизить последнего ADMIN.'),
    CREDENTIALS_NOT_PROVISIONED: t('Сначала оператор должен выдать пароль и MFA через CLI.'),
    DUPLICATE_RESOURCE: t('Такой email или slug уже существует.'),
    OFFER_CHANGED: t('Цена или длительность изменились. Выберите время заново.'),
    INVALID_STATUS_TRANSITION: t('Переход статуса недоступен в текущем состоянии или времени.'),
    INVALID_INPUT: t('Проверьте поля и формат данных.'),
    CONTACTS_UNAVAILABLE: t('Контакты недоступны. Обратитесь к ответственному за ключи.'),
  };
  return messages[error.code] ?? t('Операция не выполнена. Обновите данные и повторите.');
}
export const statuses = {
  PENDING: t('Ожидает подтверждения'),
  CONFIRMED: t('Подтверждена'),
  CANCELLED: t('Отменена'),
  COMPLETED: t('Завершена'),
  NO_SHOW: t('Неявка'),
};
export function clinicDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
}
export function range(date: string, days = 1) {
  const start = new Date(date + 'T00:00:00+05:00');
  return {
    from: start.toISOString(),
    to: new Date(start.getTime() + days * 86400000).toISOString(),
  };
}
export function time(value: string) {
  return new Intl.DateTimeFormat(adminLocale() === 'kk' ? 'kk-KZ' : 'ru-KZ', {
    timeZone: 'Asia/Almaty',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
