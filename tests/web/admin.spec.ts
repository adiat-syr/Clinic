import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { syntheticIds } from '../../apps/api/src/testing/synthetic-clinic.js';
const url = process.env.TEST_DATABASE_URL,
  password = process.env.WEB_STAFF_PASSWORD,
  secret = process.env.WEB_STAFF_MFA;
if (
  !url ||
  url !== process.env.DATABASE_URL ||
  !/^\/clinic_test_[a-f0-9]{32}$/.test(new URL(url).pathname) ||
  !password ||
  !secret
)
  throw new Error('Owned temporary database and ephemeral staff required');
const db = new pg.Pool({ connectionString: url });
let offers: { id: string; price_kzt: string; duration_minutes: number }[] = [];
test.beforeAll(async () => {
  offers = (
    await db.query<{ id: string; price_kzt: string; duration_minutes: number }>(
      'SELECT id,price_kzt,duration_minutes FROM services',
    )
  ).rows;
});
async function restore() {
  for (const s of offers)
    await db.query(
      'UPDATE services SET price_kzt=$1,duration_minutes=$2,is_active=true WHERE id=$3',
      [s.price_kzt, s.duration_minutes, s.id],
    );
}
test.beforeEach(async () => {
  await db.query(
    'TRUNCATE patient_consent_receipts,idempotency_keys,appointment_consents,appointments,staff_sessions',
  );
  await db.query('DELETE FROM rate_limit_buckets');
  await db.query('DELETE FROM availability_windows WHERE NOT(id=ANY($1::uuid[]))', [
    syntheticIds.windows,
  ]);
  await db.query(
    "UPDATE staff_users SET is_active=true,role=CASE WHEN email='web-admin@example.invalid' THEN 'ADMIN'::\"StaffRole\" ELSE 'RECEPTIONIST'::\"StaffRole\" END,mfa_last_used_counter=$1 WHERE email IN ('web-admin@example.invalid','web-reception@example.invalid')",
    [Math.floor(Date.now() / 30000) - 1],
  );
  await restore();
});
test.afterEach(restore);
test.afterAll(() => db.end());
async function login(
  page: Page,
  role: 'ADMIN' | 'RECEPTIONIST' = 'ADMIN',
  locale: 'ru' | 'kk' = 'ru',
) {
  await page.goto('/admin' + (locale === 'kk' ? '?lang=kk' : ''));
  await page
    .getByLabel('Email', { exact: true })
    .fill(role === 'ADMIN' ? 'web-admin@example.invalid' : 'web-reception@example.invalid');
  await page
    .getByLabel(locale === 'ru' ? 'Пароль' : 'Құпиясөз', { exact: true })
    .fill(password ?? '');
  await page.getByRole('button', { name: locale === 'ru' ? 'Войти' : 'Кіру', exact: true }).click();
  await page.getByLabel(locale === 'ru' ? 'Код MFA' : 'MFA коды', { exact: true }).fill(
    new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret ?? ''),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate(),
  );
  await page
    .getByRole('button', { name: locale === 'ru' ? 'Подтвердить MFA' : 'MFA растау', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: locale === 'ru' ? 'Записи на приём' : 'Қабылдауға жазылулар',
      exact: true,
    }),
  ).toBeVisible();
}
async function create(
  request: APIRequestContext,
  startsAt = (process.env.WEB_TEST_DATE ?? '') + 'T04:00:00Z',
) {
  const doc = z
      .object({ id: z.string() })
      .parse(await (await request.get('/api/v1/consent-documents/current?locale=ru')).json()),
    csrf = z
      .object({ csrfToken: z.string() })
      .parse(await (await request.get('/api/v1/auth/csrf')).json());
  const response = await request.post('/api/v1/appointments', {
    headers: {
      origin: process.env.WEB_TEST_BASE ?? '',
      'x-csrf-token': csrf.csrfToken,
      'idempotency-key': randomBytes(24).toString('hex'),
    },
    data: {
      doctorId: syntheticIds.doctors[0],
      serviceId: syntheticIds.services[0],
      startsAt,
      expectedPriceKzt: offers.find((o) => o.id === syntheticIds.services[0])?.price_kzt,
      expectedDurationMinutes: 30,
      contacts: { name: 'Синтетический посетитель', phone: '+70000000000' },
      consent: { documentId: doc.id, locale: 'ru', accepted: true },
    },
  });
  expect(response.status()).toBe(201);
  return z.object({ reference: z.string() }).parse(await response.json());
}
async function open(page: Page, reference: string) {
  await page.getByLabel('Дата', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  await page.getByRole('button', { name: 'Открыть ' + reference, exact: true }).click();
  await expect(
    page.locator('.admin-detail').getByRole('heading', { name: 'Синтетический посетитель' }),
  ).toBeVisible();
}
async function obtainPatientCode(page: Page, locale: 'ru' | 'kk' = 'ru') {
  await page.goto('/' + locale + '/phone-consent');
  await page
    .getByLabel(locale === 'ru' ? 'Ваше имя' : 'Атыңыз', { exact: true })
    .fill('Синтетический посетитель');
  await page
    .getByLabel(locale === 'ru' ? 'Номер телефона' : 'Телефон нөмірі', { exact: true })
    .fill('+70000000000');
  await expect(
    page.getByRole('button', {
      name: locale === 'ru' ? 'Получить одноразовый код' : 'Бір реттік кодты алу',
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page
    .getByRole('button', {
      name: locale === 'ru' ? 'Получить одноразовый код' : 'Бір реттік кодты алу',
      exact: true,
    })
    .click();
  const output = page.locator('output');
  await expect(output).toBeVisible();
  const code = await output.textContent();
  if (!code) throw new Error('Patient receipt required');
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  return code;
}
async function prepareManual(page: Page, code: string) {
  await page.getByRole('button', { name: 'Создать запись по коду пациента', exact: true }).click();
  await page.getByLabel('Код согласия пациента', { exact: true }).fill(code);
  await page
    .getByLabel('Врач для новой записи', { exact: true })
    .selectOption(syntheticIds.doctors[0]);
  await page
    .getByLabel('Услуга для новой записи', { exact: true })
    .selectOption(syntheticIds.services[0]);
  await page.getByLabel('Дата новой записи', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  await page.locator('.admin-inline .slots button').first().click();
}
test('patient grants consent and RECEPTIONIST books once, without supplying consent or contacts', async ({
  page,
}) => {
  const code = await obtainPatientCode(page);
  await login(page, 'RECEPTIONIST');
  await prepareManual(page, code);
  await page.getByRole('button', { name: 'Создать запись', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Заявка создана' })).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
  expect(
    (
      await db.query(
        'SELECT count(*)::int n FROM patient_consent_receipts WHERE consumed_at IS NOT NULL',
      )
    ).rows[0].n,
  ).toBe(1);
  await prepareManual(page, code);
  await page.getByRole('button', { name: 'Создать запись', exact: true }).click();
  await expect(page.locator('.admin-inline').getByRole('alert')).toContainText('уже использован');
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
});
test('manual retry after commit does not make a second appointment', async ({ page }) => {
  const code = await obtainPatientCode(page);
  await login(page);
  await prepareManual(page, code);
  let lost = false;
  await page.route('**/api/v1/admin/appointments', async (route) => {
    if (route.request().method() === 'POST' && !lost) {
      lost = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Создать запись', exact: true }).click();
  await expect(
    page.locator('.admin-inline').getByText('Ответ сервера не получен.', { exact: false }),
  ).toBeVisible();
  await page
    .locator('.admin-inline')
    .getByRole('button', { name: 'Повторить', exact: true })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Заявка создана' })).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
});
test('KK patient consent and staff catalogue, dialogs, calendar and navigation stay localized', async ({
  page,
}) => {
  await obtainPatientCode(page, 'kk');
  await login(page, 'ADMIN', 'kk');
  await expect(page.locator('html')).toHaveAttribute('lang', 'kk');
  await page.getByRole('link', { name: 'Қызметтер мен бағалар', exact: true }).click();
  await expect(page).toHaveURL(/lang=kk/);
  await page
    .getByRole('row')
    .filter({ hasText: 'Синтетикалық кеңес' })
    .getByRole('button', { name: 'Өңдеу', exact: true })
    .click();
  await expect(page.getByLabel('Бағасы KZT', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Белсенді', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Сақтау', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAttribute(
    'aria-label',
    'Каталог жазбасын өшіру керек пе?',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Артқа', exact: true }).click();
  await page.getByRole('link', { name: 'Дәрігерлер күнтізбесі', exact: true }).click();
  await expect(page.getByLabel('Күнтізбе күні', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.tmp/admin-kk-mobile.png', fullPage: true });
});
test('RECEPTIONIST password change revokes sessions and wrong password is safely rejected', async ({
  page,
}) => {
  const original = (
    await db.query<{ password_hash: string }>(
      'SELECT password_hash FROM staff_users WHERE email=$1',
      ['web-reception@example.invalid'],
    )
  ).rows[0];
  if (!original) throw new Error('Synthetic account required');
  try {
    await login(page, 'RECEPTIONIST');
    await page.getByRole('link', { name: 'Мой пароль', exact: true }).click();
    await page.getByLabel('Текущий пароль', { exact: true }).fill('incorrect-synthetic-password');
    await page
      .getByLabel('Новый пароль', { exact: true })
      .fill('SYNTHETIC-' + randomBytes(24).toString('hex'));
    await page.getByRole('button', { name: 'Сменить пароль и выйти', exact: true }).click();
    await expect(page.locator('.admin-content').getByRole('alert')).toBeVisible();
    await page.getByLabel('Текущий пароль', { exact: true }).fill(password ?? '');
    await page
      .getByLabel('Новый пароль', { exact: true })
      .fill('SYNTHETIC-' + randomBytes(24).toString('hex'));
    await page.getByRole('button', { name: 'Сменить пароль и выйти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Вход сотрудника', exact: true })).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  } finally {
    await db.query('UPDATE staff_users SET password_hash=$1 WHERE email=$2', [
      original.password_hash,
      'web-reception@example.invalid',
    ]);
  }
});

test('anonymous and password-only sessions cannot enter protected workspace', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Вход сотрудника' })).toBeVisible();
  expect((await page.request.get('/api/v1/admin/staff')).status()).toBe(401);
  await page.getByLabel('Email', { exact: true }).fill('web-admin@example.invalid');
  await page.getByLabel('Пароль', { exact: true }).fill(password ?? '');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Код MFA')).toBeVisible();
  expect(
    (
      await page.request.get(
        '/api/v1/admin/appointments?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z',
      )
    ).status(),
  ).toBe(401);
  await expect(page.getByRole('heading', { name: 'Записи на приём' })).toHaveCount(0);
});
test('receptionist filters, opens audited contacts, confirms and cancels', async ({ page }) => {
  const booking = await create(page.request);
  await login(page, 'RECEPTIONIST');
  await open(page, booking.reference);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.locator('.admin-detail .status')).toHaveText('Подтверждена');
  await page.getByRole('button', { name: 'Отменить запись', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.locator('.admin-detail .status')).toHaveText('Отменена');
  expect((await db.query('SELECT status FROM appointments')).rows[0].status).toBe('CANCELLED');
  expect(
    (
      await db.query(
        "SELECT count(*)::int n FROM audit_events WHERE action='APPOINTMENT_CONTACTS_READ' AND actor_user_id IS NOT NULL",
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
  await page.getByLabel('Статус', { exact: true }).selectOption('PENDING');
  await expect(page.getByText('На выбранную дату записей нет.')).toBeVisible();
});
test('receptionist cannot access ADMIN routes or APIs', async ({ page }) => {
  await login(page, 'RECEPTIONIST');
  await page.goto('/admin/staff');
  await expect(page.getByRole('heading', { name: 'Недостаточно прав' })).toBeVisible();
  expect((await page.request.get('/api/v1/admin/staff')).status()).toBe(403);
  await expect(page.getByRole('link', { name: 'Сотрудники', exact: true })).toHaveCount(0);
});
test('session revocation removes the private contact card', async ({ page }) => {
  const booking = await create(page.request);
  await login(page);
  await open(page, booking.reference);
  await db.query('UPDATE staff_sessions SET revoked_at=now()');
  await page.getByRole('button', { name: 'Обновить карточку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход сотрудника' })).toBeVisible();
  await expect(page.getByText('Синтетический посетитель', { exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
});
test('ADMIN edits price/duration and archives service with confirmation', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Услуги и цены', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Синтетическая консультация' });
  await row.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByLabel('Цена KZT', { exact: true }).fill('13000.00');
  await page.getByLabel('Длительность, минут', { exact: true }).fill('35');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(row).toContainText('13000.00');
  await row.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Активно', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(row).toContainText('Архив');
  expect((await page.request.get('/api/v1/services/synthetic-therapy')).status()).toBe(404);
});
test('ADMIN creates inactive staff and cannot block the last ADMIN', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Сотрудники', exact: true }).click();
  await page.getByLabel('Email нового сотрудника').fill('synthetic-new-web@example.invalid');
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'synthetic-new-web@example.invalid' }),
  ).toContainText('Заблокирован');
  const row = page.getByRole('row').filter({ hasText: 'web-admin@example.invalid' });
  await row.getByRole('button', { name: 'Заблокировать', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('последнего ADMIN');
});
test('calendar creates and removes work interval on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'RECEPTIONIST');
  await page.getByRole('link', { name: 'Календарь врачей', exact: true }).click();
  const date = new Date((process.env.WEB_TEST_DATE ?? '') + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 2);
  const day = date.toISOString().slice(0, 10);
  await page.getByLabel('Дата календаря').fill(day);
  await page.getByLabel('Врач календаря', { exact: true }).selectOption(syntheticIds.doctors[0]);
  await page.getByLabel('Начало', { exact: true }).fill(day + 'T09:00');
  await page.getByLabel('Окончание', { exact: true }).fill(day + 'T12:00');
  await page.getByRole('button', { name: 'Добавить интервал', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Удалить интервал', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Удалить интервал', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByText('Рабочих интервалов нет.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.tmp/admin-mobile.png', fullPage: true });
});
test('logout revokes the server session and hides protected data', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход сотрудника' })).toBeVisible();
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
});

test('ADMIN creates a doctor, assigns an actual service and archives safely', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Врачи клиники', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить врача', exact: true }).click();
  await page.getByLabel('Slug', { exact: true }).fill('synthetic-web-doctor');
  await page.getByLabel('Имя RU', { exact: true }).fill('Синтетический врач браузера');
  await page.getByLabel('Имя KK', { exact: true }).fill('Синтетикалық дәрігер');
  await page.getByLabel('Специальность RU', { exact: true }).fill('Терапевт');
  await page.getByLabel('Специальность KK', { exact: true }).fill('Терапевт');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Синтетический врач браузера' });
  await row.getByRole('button', { name: 'Назначить услуги', exact: true }).click();
  await page
    .getByLabel('Назначаемая услуга', { exact: true })
    .selectOption(syntheticIds.services[0]);
  await page.getByRole('button', { name: 'Сохранить назначение', exact: true }).click();
  await expect(row).toContainText('1 активных услуг');
  expect((await page.request.get('/api/v1/doctors/synthetic-web-doctor')).status()).toBe(200);
  await row.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Активно', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(row).toContainText('Архив');
  expect((await page.request.get('/api/v1/doctors/synthetic-web-doctor')).status()).toBe(404);
});

test('queue network error is recoverable and desktop layout stays within viewport', async ({
  page,
}) => {
  await login(page);
  await page.route('**/api/v1/admin/appointments?**', (route) => route.abort());
  await page.getByLabel('Дата', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  await expect(page.locator('.admin-content').getByRole('alert')).toBeVisible();
  await page.unroute('**/api/v1/admin/appointments?**');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByText('На выбранную дату записей нет.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.tmp/admin-desktop.png', fullPage: true });
});
test('receptionist reschedules using actual availability and server version', async ({ page }) => {
  const booking = await create(page.request);
  await login(page, 'RECEPTIONIST');
  await open(page, booking.reference);
  await page.getByRole('button', { name: 'Перенести время', exact: true }).click();
  await page.getByLabel('Новая дата', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  const free = await page.request.get(
    '/api/v1/availability?' +
      new URLSearchParams({
        doctorId: syntheticIds.doctors[0],
        serviceId: syntheticIds.services[0],
        date: process.env.WEB_TEST_DATE ?? '',
      }),
  );
  const data = z
    .object({ slots: z.array(z.object({ startsAt: z.string() })) })
    .parse(await free.json());
  const target = data.slots[0]?.startsAt;
  if (!target) throw new Error('Synthetic slot required');
  await page.locator('.admin-inline .slots button').first().click();
  await page.getByRole('button', { name: 'Сохранить перенос', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Перенос записи', exact: true })).toHaveCount(0);
  expect(
    (await db.query('SELECT starts_at,version FROM appointments')).rows[0].starts_at.toISOString(),
  ).toBe(target);
  expect((await db.query('SELECT version FROM appointments')).rows[0].version).toBe(2);
});
test('a competing booking rejects staff reschedule without losing the original', async ({
  page,
}) => {
  const booking = await create(page.request);
  await login(page, 'RECEPTIONIST');
  await open(page, booking.reference);
  await page.getByRole('button', { name: 'Перенести время', exact: true }).click();
  await page.getByLabel('Новая дата', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  const data = z.object({ slots: z.array(z.object({ startsAt: z.string() })) }).parse(
    await (
      await page.request.get(
        '/api/v1/availability?' +
          new URLSearchParams({
            doctorId: syntheticIds.doctors[0],
            serviceId: syntheticIds.services[0],
            date: process.env.WEB_TEST_DATE ?? '',
          }),
      )
    ).json(),
  );
  const target = data.slots[0]?.startsAt;
  if (!target) throw new Error('Synthetic slot required');
  await page.locator('.admin-inline .slots button').first().click();
  await create(page.request, target);
  await page.getByRole('button', { name: 'Сохранить перенос', exact: true }).click();
  await expect(page.locator('.admin-inline').getByRole('alert')).toContainText(
    'Исходная запись сохранена',
  );
  const original = await db.query('SELECT starts_at,version FROM appointments WHERE reference=$1', [
    booking.reference,
  ]);
  expect(original.rows[0].starts_at.toISOString()).toBe(
    (process.env.WEB_TEST_DATE ?? '') + 'T04:00:00.000Z',
  );
  expect(original.rows[0].version).toBe(1);
});
test('ADMIN can view audit and record verified consent withdrawal', async ({ page }) => {
  const booking = await create(page.request);
  await login(page);
  await open(page, booking.reference);
  await page.getByRole('button', { name: 'Зафиксировать отзыв согласия', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByText('Отзыв согласия:', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Аудит', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Аудит действий' })).toBeVisible();
  await expect(page.getByText('CONSENT_WITHDRAWAL_RECORDED', { exact: true })).toBeVisible();
});
