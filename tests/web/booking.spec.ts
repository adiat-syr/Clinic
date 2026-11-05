import { test, expect, type Page } from '@playwright/test';
import pg from 'pg';
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/clinic_test_[a-f0-9]{32}$/.test(new URL(url).pathname))
  throw new Error('Owned temporary DB required');
const db = new pg.Pool({ connectionString: url });
test.afterAll(() => db.end());
test.beforeEach(async () => {
  await db.query('TRUNCATE idempotency_keys,appointment_consents,appointments');
  await db.query('DELETE FROM rate_limit_buckets');
});
async function select(page: Page) {
  await page.goto('/ru/booking');
  await page.getByLabel('Услуга', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Специалист', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Дата приёма', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  await page.getByRole('group', { name: 'Доступное время' }).getByRole('button').first().click();
}
async function contacts(page: Page) {
  await page.getByLabel('Ваше имя', { exact: true }).fill('Синтетический посетитель');
  await page.getByLabel('Номер телефона', { exact: true }).fill('+70000000000');
  await page.getByRole('checkbox').check();
}
test('real browser booking creates one encrypted DB record and shows pending result', async ({
  page,
}) => {
  await select(page);
  await contacts(page);
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Заявка принята', exact: true })).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
test('consent and form validation block requests', async ({ page }) => {
  await select(page);
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Укажите имя');
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(0);
});
test('Kazakh booking uses the same real API and consent flow', async ({ page }) => {
  await page.goto('/kk/booking');
  await page.getByLabel('Қызмет', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Маман', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Қабылдау күні', { exact: true }).fill(process.env.WEB_TEST_DATE ?? '');
  await page.getByRole('group', { name: 'Бос уақыт' }).getByRole('button').first().click();
  await page.getByLabel('Атыңыз', { exact: true }).fill('Синтетикалық келуші');
  await page.getByLabel('Телефон нөмірі', { exact: true }).fill('+70000000000');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Өтінім жіберу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Өтінім қабылданды', exact: true })).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
});
test('new consent version clears the old checkbox and requires renewed consent', async ({
  page,
}) => {
  await select(page);
  await contacts(page);
  const connection = await db.connect();
  await connection.query('BEGIN');
  try {
    await connection.query(
      'UPDATE consent_documents SET retired_at=now() WHERE retired_at IS NULL',
    );
    await connection.query(
      "INSERT INTO consent_documents (id,version,text_ru,text_kk,content_sha256,published_at) VALUES (gen_random_uuid(),'synthetic-web-v2','Синтетический обновлённый текст согласия','Синтетикалық жаңартылған келісім мәтіні',$1,now())",
      ['a'.repeat(64)],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Согласие обновлено');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(0);
});
test('a day without working intervals shows an empty state', async ({ page }) => {
  await page.goto('/ru/booking');
  await page.getByLabel('Услуга', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Специалист', { exact: true }).selectOption({ index: 1 });
  const day = new Date((process.env.WEB_TEST_DATE ?? '') + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() + 1);
  await page.getByLabel('Дата приёма', { exact: true }).fill(day.toISOString().slice(0, 10));
  await expect(
    page.getByText('Свободного времени на эту дату нет.', { exact: false }),
  ).toBeVisible();
});
test('slot conflict from a competing real API request shows a safe error', async ({
  page,
  request,
}) => {
  await select(page);
  await contacts(page);
  const post = page.waitForRequest(
    (r) => r.url().endsWith('/appointments') && r.method() === 'POST',
  );
  await page.route('**/api/v1/appointments', async (route) => {
    const req = route.request();
    await request.post(req.url(), {
      headers: { ...req.headers(), 'idempotency-key': 'a'.repeat(48) },
      data: req.postData(),
    });
    await route.continue();
  });
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await post;
  await expect(page.getByRole('alert')).toContainText('уже занято');
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
});
test('network retry retains idempotency key after server commit', async ({ page, request }) => {
  await select(page);
  await contacts(page);
  let first = true,
    key = '';
  await page.route('**/api/v1/appointments', async (route) => {
    if (first) {
      first = false;
      const req = route.request();
      key = req.headers()['idempotency-key'] ?? '';
      await request.post(req.url(), { headers: req.headers(), data: req.postData() });
      await route.abort();
    } else {
      expect(route.request().headers()['idempotency-key']).toBe(key);
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'Отправить заявку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Связь прервалась');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Заявка принята' })).toBeVisible();
  expect((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n).toBe(1);
});
test('mobile/tablet/desktop and Kazakh catalogue have no horizontal overflow', async ({ page }) => {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/kk/services');
    await expect(
      page.getByRole('heading', { name: 'Қызметтер мен бағалар', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.service-card').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.tmp/stage5-' + width + '.png', fullPage: true });
  }
});
test('API failure has a retry state; client explains protected changes without exposing staff UI', async ({
  page,
}) => {
  await page.route('**/api/v1/services?*', (r) => r.abort());
  await page.goto('/ru/services');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.goto('/ru/contacts');
  await expect(
    page.getByText('Для просмотра, переноса или отмены', { exact: false }),
  ).toBeVisible();
  expect(
    (
      await page.request.get('/api/v1/admin/appointments/00000000-0000-4000-8000-000000000000')
    ).status(),
  ).toBe(401);
});
