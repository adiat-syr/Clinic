import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
const state = z
  .object({
    name: z.string().regex(/^clinic_test_[a-f0-9]{32}$/),
    email: z.string(),
    password: z.string(),
    mfa: z.string(),
    date: z.string(),
  })
  .parse(JSON.parse(readFileSync(process.env.WEB_HTTPS_STATE_FILE ?? '', 'utf8')));
mkdirSync('.tmp/screens', { recursive: true });
async function login(page: Page) {
  await page.goto('/admin');
  await page.getByLabel('Email', { exact: true }).fill(state.email);
  await page.getByLabel('Пароль', { exact: true }).fill(state.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Код MFA', { exact: true })).toBeVisible();
  await page.getByLabel('Код MFA', { exact: true }).fill(
    new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(state.mfa),
      digits: 6,
      period: 30,
    }).generate(),
  );
  await page.getByRole('button', { name: 'Подтвердить MFA', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Записи на приём', exact: true })).toBeVisible();
}
test('production HTTPS pages, current catalogue, unknown URL and security headers', async ({
  page,
  request,
}) => {
  const response = await page.goto('/ru');
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('link', { name: 'Услуги и цены', exact: true }).first(),
  ).toBeVisible();
  expect(response?.headers()['strict-transport-security']).toContain('max-age=');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await page.screenshot({ path: '.tmp/screens/stage7-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'Услуги и цены', exact: true }).first().click();
  await expect(page.getByText('Синтетическая консультация', { exact: true })).toBeVisible();
  const missing = await request.get('/ru/doctors/does-not-exist');
  expect(missing.status()).toBe(404);
  expect(await missing.text()).not.toContain('mfa_secret_ciphertext');
});
test('online booking through real API handles consent and returns pending status', async ({
  page,
}) => {
  await page.goto('/ru/booking');
  await page
    .getByLabel('Услуга', { exact: true })
    .selectOption({ label: 'Синтетическая консультация' });
  await page.getByLabel('Специалист', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Дата приёма', { exact: true }).fill(state.date);
  await expect(page.locator('.slots button').first()).toBeVisible();
  await page.locator('.slots button').first().click();
  await page.getByLabel('Ваше имя', { exact: true }).fill('Синтетический HTTPS посетитель');
  await page.getByLabel('Номер телефона', { exact: true }).fill('+70000008888');
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('подтвердите согласие');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Заявка принята', exact: true })).toBeVisible();
  await expect(
    page.getByText('Это заявка, а не подтверждённый приём.', { exact: false }),
  ).toBeVisible();
});
test('mobile KK navigation and keyboard-accessible booking', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/kk');
  await page
    .locator('.mobile-nav')
    .getByRole('link', { name: 'Онлайн жазылу', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Онлайн жазылу', exact: true, level: 1 }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await page.screenshot({ path: '.tmp/screens/stage7-mobile-kk.png', fullPage: true });
});
test('MFA login uses secure host cookie, CSRF is enforced and logout revokes access', async ({
  page,
  context,
}) => {
  await login(page);
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-clinic_session');
  expect(cookie?.secure).toBe(true);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.path).toBe('/');
  const service = z
    .array(z.object({ id: z.string(), slug: z.string(), nameRu: z.string() }))
    .parse((await (await page.request.get('/api/v1/services')).json()).items)
    .find((s) => s.slug === 'synthetic-diagnostics');
  if (!service) throw new Error('Synthetic service missing');
  const mutation = async (body: Record<string, unknown>) =>
    page.evaluate(
      async ({ id, body }) => {
        const csrf: unknown = await (await fetch('/api/v1/auth/csrf')).json();
        if (
          typeof csrf !== 'object' ||
          !csrf ||
          !('csrfToken' in csrf) ||
          typeof csrf.csrfToken !== 'string'
        )
          throw new Error('CSRF unavailable');
        return (
          await fetch('/api/v1/admin/services/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken },
            body: JSON.stringify(body),
          })
        ).status;
      },
      { id: service.id, body },
    );
  expect(await mutation({ isActive: false })).toBe(200);
  const obsolete = await page.request.get('/ru/services/' + service.slug);
  expect(obsolete.status()).toBe(404);
  expect(await obsolete.text()).not.toContain('Синтетическая диагностика');
  expect(await mutation({ isActive: true })).toBe(200);
  expect((await page.request.get('/ru/services/' + service.slug)).status()).toBe(200);
  const payload = '</script><img src=x onerror="globalThis.__clinicXss=true">';
  expect(await mutation({ nameRu: payload })).toBe(200);
  const html = await page.request.get('/ru/services/' + service.slug);
  expect(await html.text()).not.toContain('</script><img');
  const viewer = await context.newPage();
  await viewer.goto('/ru/services/' + service.slug);
  await expect(viewer.getByRole('heading', { name: payload, exact: true, level: 2 })).toBeVisible();
  expect(await viewer.evaluate(() => Reflect.get(globalThis, '__clinicXss'))).toBeUndefined();
  await viewer.close();
  expect(await mutation({ nameRu: service.nameRu })).toBe(200);
  expect(
    (
      await page.request.get(
        '/api/v1/services?page=' + encodeURIComponent('1;DROP TABLE services;'),
      )
    ).status(),
  ).toBe(400);
  expect(
    (await page.request.get('/api/v1/doctors/' + encodeURIComponent("x' OR 1=1--"))).status(),
  ).toBe(400);
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/v1/auth/logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
    ),
  ).toBe(403);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход сотрудника', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/v1/admin/appointments')).status)).toBe(
    401,
  );
});
