import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ClinicProfile } from '../../config/clinic.js';
import type { CatalogService } from '../catalog/service.js';

type PublicSnapshot = {
  clinic: ClinicProfile & { phoneConsentEnabled: boolean; bookingEnabled: boolean };
  doctors: Awaited<ReturnType<CatalogService['doctors']>>['items'];
  services: Awaited<ReturnType<CatalogService['services']>>['items'];
};
const rendererSchema = z.object({
  render: z.custom<(path: string, data: PublicSnapshot) => string>((v) => typeof v === 'function'),
});
const escape = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// Presentation adapter for the existing React renderer. Only public catalogue DTOs reach HTML.
// Read live data so catalogue changes/deactivation do not leave obsolete static pages online.
export class SiteService {
  private snapshot:
    { expires: number; data: Pick<PublicSnapshot, 'services' | 'doctors'> } | undefined;
  private pending: Promise<Pick<PublicSnapshot, 'services' | 'doctors'>> | undefined;
  private generation = 0;
  invalidate() {
    this.generation++;
    this.snapshot = undefined;
    this.pending = undefined;
  }
  private readonly template = readFile(
    new URL('../../../../web/dist/prerender-template.html', import.meta.url),
    'utf8',
  );
  constructor(
    private readonly catalog: CatalogService,
    private readonly clinic: PublicSnapshot['clinic'],
    private readonly origin: string,
  ) {}
  async render(path: string) {
    const parts = path.split('/').filter(Boolean),
      locale = parts[0] === 'kk' ? 'kk' : 'ru';
    const page = parts[1] ?? '',
      slug = parts[2];
    const known =
      parts.length <= 3 &&
      ['', 'services', 'doctors', 'booking', 'contacts', 'privacy', 'phone-consent'].includes(
        page,
      ) &&
      (!slug || ['services', 'doctors'].includes(page));
    const all = async <T>(
      fetchPage: (q: {
        page: number;
        pageSize: number;
      }) => Promise<{ items: T[]; pagination: { total: number } }>,
    ) => {
      const rows: T[] = [];
      for (let page = 1; page <= 100; page++) {
        const r = await fetchPage({ page, pageSize: 100 });
        rows.push(...r.items);
        if (rows.length >= r.pagination.total) return rows;
      }
      throw new Error('Public catalogue too large');
    };
    const generation = this.generation;
    const load = () =>
      Promise.all([all((q) => this.catalog.services(q)), all((q) => this.catalog.doctors(q))]).then(
        ([services, doctors]) => ({ services, doctors }),
      );
    let publicData: Pick<PublicSnapshot, 'services' | 'doctors'> = { services: [], doctors: [] };
    if (known) {
      if (this.snapshot && this.snapshot.expires > Date.now()) publicData = this.snapshot.data;
      else {
        const task = this.pending ?? load();
        this.pending = task;
        try {
          publicData = await task;
          if (this.generation === generation)
            this.snapshot = { expires: Date.now() + 2000, data: publicData };
        } finally {
          if (this.pending === task) this.pending = undefined;
        }
      }
    }
    const { services, doctors } = publicData;
    const selected = slug
      ? (page === 'services' ? services : doctors).find((v) => v.slug === slug)
      : undefined;
    const found = known && (!slug || !!selected),
      data: PublicSnapshot = { services, doctors, clinic: this.clinic };
    const modulePath = new URL('../../../../web/dist-server/entry-server.js', import.meta.url).href;
    const renderer = rendererSchema.parse(await import(modulePath));
    const title = selected
      ? locale === 'ru'
        ? selected.nameRu
        : selected.nameKk
      : this.clinic.name[locale];
    const body = z
      .string()
      .parse(renderer.render(found ? (path === '/' ? '/ru' : path) : '/' + locale + '/404', data));
    const route = path === '/' ? '/ru' : path;
    const html = (await this.template)
      .replace('<html lang="ru">', `<html lang="${locale}">`)
      .replace(/<title>[^<]*<\/title>/, `<title>${escape(title)}</title>`)
      .replace(
        '<div id="root"></div>',
        `<div id="root">${body}</div><script id="catalog-data" type="application/json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`,
      )
      .replace(
        '</head>',
        found
          ? `<link rel="canonical" href="${escape(this.origin + route)}"/></head>`
          : '<meta name="robots" content="noindex"/></head>',
      );
    return { status: found ? 200 : 404, html };
  }
}
