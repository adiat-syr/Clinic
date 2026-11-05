import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { render } from '../dist-server/entry-server.js';
const root = new URL('../../../', import.meta.url),
  env = new URL('.env', root);
if (existsSync(env)) loadEnvFile(env);
let data = { services: [], doctors: [] };
try {
  const { createPrisma } = await import('../../api/dist/infrastructure/prisma.js'),
    { CatalogService } = await import('../../api/dist/modules/catalog/service.js');
  const client = createPrisma(process.env.DATABASE_URL);
  try {
    const catalog = new CatalogService(client);
    async function all(fn) {
      let page = 1,
        items = [];
      while (page <= 100) {
        const row = await fn({ page, pageSize: 100 });
        items.push(...row.items);
        if (items.length >= row.pagination.total) return items;
        page++;
      }
      throw new Error('Catalog too large');
    }
    data = {
      services: await all((q) => catalog.services(q)),
      doctors: await all((q) => catalog.doctors(q)),
    };
  } finally {
    await client.$disconnect();
  }
} catch {
  if (process.env.SEO_REQUIRED === 'true') throw new Error('Public catalogue snapshot unavailable');
  console.warn(
    'Public catalogue snapshot unavailable; static shell only. Rebuild with DB available before publication.',
  );
}
const templateFile = new URL('../dist/prerender-template.html', import.meta.url);
const template = await readFile(
    existsSync(templateFile) ? templateFile : new URL('../dist/index.html', import.meta.url),
    'utf8',
  ),
  paths = [];
await writeFile(templateFile, template);
for (const locale of ['ru', 'kk'])
  for (const path of [
    '',
    '/services',
    '/doctors',
    '/booking',
    '/contacts',
    '/privacy',
    ...data.services.map((s) => '/services/' + s.slug),
    ...data.doctors.map((d) => '/doctors/' + d.slug),
  ]) {
    const escape = (v) =>
      v
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const label =
      (locale === 'ru'
        ? {
            '': 'Главная',
            '/services': 'Услуги и цены',
            '/doctors': 'Врачи',
            '/booking': 'Онлайн-запись',
            '/contacts': 'Контакты',
            '/privacy': 'Персональные данные',
          }
        : {
            '': 'Басты бет',
            '/services': 'Қызметтер мен бағалар',
            '/doctors': 'Дәрігерлер',
            '/booking': 'Онлайн жазылу',
            '/contacts': 'Байланыс',
            '/privacy': 'Дербес деректер',
          })[path] ??
      [...data.services, ...data.doctors].find((x) => path.endsWith('/' + x.slug))?.[
        locale === 'ru' ? 'nameRu' : 'nameKk'
      ] ??
      'Alatau';
    const route = '/' + locale + path;
    paths.push(route);
    let html = template
      .replace('<html lang="ru">', `<html lang="${locale}">`)
      .replace(
        '<div id="root"></div>',
        `<div id="root">${render(route, data)}</div><script id="catalog-data" type="application/json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`,
      )
      .replace(
        '<title>Alatau Clinic — разработка</title>',
        `<title>Alatau Clinic · ${escape(label)}</title>`,
      );
    const origin = process.env.PUBLIC_SITE_ORIGIN;
    if (origin) {
      const url = new URL(origin);
      if (
        url.protocol !== 'https:' ||
        url.pathname !== '/' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error('Invalid PUBLIC_SITE_ORIGIN');
      html = html.replace(
        '</head>',
        `<link rel="canonical" href="${url.origin}${route}"/><link rel="alternate" hreflang="ru" href="${url.origin}/ru${path}"/><link rel="alternate" hreflang="kk" href="${url.origin}/kk${path}"/></head>`,
      );
    }
    const dir = new URL('../dist' + route + '/', import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL('index.html', dir), html);
  }
await writeFile(
  new URL('../dist/404.html', import.meta.url),
  template.replace('<div id="root"></div>', `<div id="root">${render('/ru/404', data)}</div>`),
);
await writeFile(
  new URL('../dist/index.html', import.meta.url),
  await readFile(new URL('../dist/ru/index.html', import.meta.url)),
);
if (process.env.PUBLIC_SITE_ORIGIN)
  await writeFile(
    new URL('../dist/sitemap.xml', import.meta.url),
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
      paths
        .map((p) => '<url><loc>' + new URL(p, process.env.PUBLIC_SITE_ORIGIN).href + '</loc></url>')
        .join('') +
      '</urlset>',
  );
console.log(
  `Prerendered ${paths.length} public routes from PostgreSQL public DTOs; no contact data.`,
);
