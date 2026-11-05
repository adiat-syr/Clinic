import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { doctors, services, type Service, type Doctor } from '../api/clinic';
import { Booking } from '../features/Booking';
import { copy, type Locale } from './i18n';
import './site.css';
export function App({
  path = typeof location === 'undefined' ? '/ru' : location.pathname,
}: {
  path?: string;
}) {
  const locale: Locale = path.split('/')[1] === 'kk' ? 'kk' : 'ru',
    t = copy[locale],
    parts = path.split('/').filter(Boolean),
    page =
      parts.length > 3 || (parts.length > 0 && !['ru', 'kk'].includes(parts[0] ?? ''))
        ? '404'
        : (parts[1] ?? 'home'),
    slug = parts[2];
  const [search, setSearch] = useState('');
  const catalog = useQuery({
      queryKey: ['services'],
      queryFn: ({ signal }) => services(signal),
      retry: false,
    }),
    team = useQuery({
      queryKey: ['doctors'],
      queryFn: ({ signal }) => doctors(signal),
      retry: false,
    });
  const href = (p: string) => `/${locale}${p === 'home' ? '' : '/' + p}`,
    nav = [
      ['home', t.home],
      ['services', t.services],
      ['doctors', t.doctors],
      ['booking', t.booking],
      ['contacts', t.contacts],
    ] as const;
  const title =
    page === 'home'
      ? t.hero
      : page === 'services'
        ? t.services
        : page === 'doctors'
          ? t.specialists
          : page === 'booking'
            ? t.booking
            : page === 'contacts'
              ? t.contacts
              : page === 'privacy'
                ? t.privacy
                : t.notfound;
  const price = (s: Service) => `${Number(s.priceKzt).toLocaleString('ru-KZ')} ₸`;
  const serviceCard = (s: Service) => (
    <article className="panel service-card" key={s.id}>
      <div className="card-top">
        <span className="badge">
          {s.durationMinutes} {t.minutes}
        </span>
        <strong className="price">{price(s)}</strong>
      </div>
      <h2>
        <a href={href('services/' + s.slug)}>{locale === 'ru' ? s.nameRu : s.nameKk}</a>
      </h2>
      <p>{locale === 'ru' ? s.descriptionRu : s.descriptionKk}</p>
      <div className="card-bottom">
        <a href={href('services/' + s.slug)}>{t.details}</a>
        <a className="button" href={`${href('booking')}?service=${s.id}`}>
          {t.choose}
        </a>
      </div>
    </article>
  );
  const doctorCard = (d: Doctor) => (
    <article className="panel doctor-card" key={d.id}>
      <div className="doctor-heading">
        <div className="portrait" aria-hidden="true">
          {(locale === 'ru' ? d.nameRu : d.nameKk)
            .split(' ')
            .map((x) => x[0])
            .slice(0, 2)
            .join('')}
        </div>
        <div>
          <span className="eyebrow">{locale === 'ru' ? d.specialtyRu : d.specialtyKk}</span>
          <h2>
            <a href={href('doctors/' + d.slug)}>{locale === 'ru' ? d.nameRu : d.nameKk}</a>
          </h2>
        </div>
      </div>
      <p>{locale === 'ru' ? d.bioRu : d.bioKk}</p>
      <div className="offer-strip">
        {d.services.length ? (
          <>
            <span>{t.from}</span>
            <strong className="price">
              {Number(Math.min(...d.services.map((s) => Number(s.priceKzt)))).toLocaleString(
                'ru-KZ',
              )}{' '}
              ₸
            </strong>
          </>
        ) : (
          <span>{t.noDoctors}</span>
        )}
      </div>
      <a
        className="button wide"
        href={`${href('booking')}?doctor=${d.id}${d.services[0] ? '&service=' + d.services[0].id : ''}`}
      >
        {t.choose}
      </a>
    </article>
  );
  const needs = ['home', 'services', 'doctors', 'booking'].includes(page),
    busy = needs && (catalog.isPending || team.isPending),
    error = needs && (catalog.isError || team.isError),
    selectedService = catalog.data?.find((s) => s.slug === slug),
    selectedDoctor = team.data?.find((d) => d.slug === slug);
  return (
    <>
      <a className="skip" href="#main">
        {t.booking}
      </a>
      <header className="site-header">
        <a href={href('home')} className="brand">
          <span className="brand-icon" aria-hidden="true">
            ✚
          </span>
          <span>
            ALATAU <small>CLINIC</small>
          </span>
        </a>
        <nav aria-label={t.home}>
          {nav.map(([p, label]) => (
            <a key={p} aria-current={page === p ? 'page' : undefined} href={href(p)}>
              {label}
            </a>
          ))}
        </nav>
        <div className="languages">
          {(['ru', 'kk'] as const).map((l) => (
            <a
              key={l}
              lang={l}
              aria-current={locale === l ? 'true' : undefined}
              href={'/' + l + '/' + (page === 'home' ? '' : page) + (slug ? '/' + slug : '')}
            >
              {l === 'ru' ? 'RU' : 'ҚАЗ'}
            </a>
          ))}
        </div>
      </header>
      <div className="environment">{t.synthetic}</div>
      <main id="main" className="container">
        {page === 'home' && (
          <section className="hero">
            <div>
              <span className="eyebrow">ALATAU CLINIC</span>
              <h1>{t.hero}</h1>
              <p className="lead">{t.intro}</p>
              <a className="button" href={href('booking')}>
                {t.booking}
              </a>
              <a className="text-link" href={href('doctors')}>
                {t.specialists}
              </a>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="cross">✚</div>
              <div className="art-caption">
                ALATAU
                <br />
                <span>CLINIC</span>
              </div>
            </div>
          </section>
        )}
        {page !== 'home' && page !== 'booking' && <h1>{title}</h1>}
        {busy && (
          <p role="status" className="panel">
            {t.loading}
          </p>
        )}
        {error && (
          <div role="alert" className="panel">
            <p>{t.error}</p>
            <button
              type="button"
              onClick={() => {
                void catalog.refetch();
                void team.refetch();
              }}
            >
              {t.retry}
            </button>
          </div>
        )}
        {!busy && !error && page === 'home' && (
          <>
            <section>
              <div className="section-title">
                <h2>{t.services}</h2>
                <a href={href('services')}>{t.all}</a>
              </div>
              <div className="cards">{catalog.data?.slice(0, 3).map(serviceCard)}</div>
            </section>
            <section>
              <div className="section-title">
                <h2>{t.specialists}</h2>
                <a href={href('doctors')}>{t.doctors}</a>
              </div>
              <div className="cards">{team.data?.slice(0, 3).map(doctorCard)}</div>
            </section>
            <section className="cta panel">
              <h2>{t.booking}</h2>
              <p>{t.intro}</p>
              <a className="button" href={href('booking')}>
                {t.choose}
              </a>
            </section>
          </>
        )}
        {!busy && !error && (page === 'services' || page === 'doctors') && (
          <>
            {!slug && (
              <label className="search">
                <span>{t.search}</span>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            )}
            {slug ? (
              page === 'services' ? (
                selectedService ? (
                  <>
                    <div className="detail-card">{serviceCard(selectedService)}</div>
                    <h2>{t.specialists}</h2>
                    <div className="cards">
                      {team.data
                        ?.filter((d) => d.services.some((s) => s.id === selectedService.id))
                        .map(doctorCard)}
                    </div>
                  </>
                ) : (
                  <p>{t.notfound}</p>
                )
              ) : selectedDoctor ? (
                <>
                  <div className="detail-card">{doctorCard(selectedDoctor)}</div>
                  <h2>{t.services}</h2>
                  <div className="cards">{selectedDoctor.services.map(serviceCard)}</div>
                </>
              ) : (
                <p>{t.notfound}</p>
              )
            ) : (
              <div className="cards">
                {page === 'services'
                  ? catalog.data
                      ?.filter((s) =>
                        (locale === 'ru' ? s.nameRu : s.nameKk)
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map(serviceCard)
                  : team.data
                      ?.filter((d) =>
                        (locale === 'ru'
                          ? d.nameRu + ' ' + d.specialtyRu
                          : d.nameKk + ' ' + d.specialtyKk
                        )
                          .toLowerCase()
                          .includes(search.toLowerCase()),
                      )
                      .map(doctorCard)}
              </div>
            )}
          </>
        )}
        {!busy && !error && page === 'booking' && (
          <Booking services={catalog.data ?? []} doctors={team.data ?? []} locale={locale} />
        )}
        {page === 'contacts' && (
          <div className="two-columns">
            <section className="panel">
              <h2>Alatau Clinic</h2>
              <p>{t.synthetic}</p>
              <p>
                {locale === 'ru'
                  ? 'Реквизиты, адрес и телефон реальной клиники ещё не утверждены. Эта версия предназначена только для проверки записи с вымышленными контактами.'
                  : 'Нақты клиниканың мекенжайы мен телефоны әлі бекітілген жоқ. Бұл нұсқа тек ойдан шығарылған деректермен тексеруге арналған.'}
              </p>
              <a className="button" href={href('booking')}>
                {t.booking}
              </a>
            </section>
            <section className="panel">
              <h2>{t.change}</h2>
              <p>{t.changeText}</p>
              <p>
                {locale === 'ru'
                  ? 'В демонстрационной среде заявку проверяет уполномоченный оператор через защищённый API. Публичного поиска по телефону или номеру заявки нет.'
                  : 'Демонстрациялық ортада өтінімді уәкілетті оператор қорғалған API арқылы тексереді. Телефон не өтінім нөмірі бойынша ашық іздеу жоқ.'}
              </p>
            </section>
          </div>
        )}
        {page === 'privacy' && (
          <section className="panel prose">
            <h2>{t.consent}</h2>
            <p>{t.synthetic}</p>
            <p>{t.safe}</p>
            <p>
              {locale === 'ru'
                ? 'Для заявки запрашиваются только имя, телефон, услуга, врач, время и согласие. Контакты хранятся в зашифрованном виде. Актуальное согласие доступно в форме до отправки. Сроки хранения и регламент обращений реальной клиники должны быть утверждены до запуска.'
                : 'Өтінім үшін тек аты, телефон, қызмет, дәрігер, уақыт және келісім сұралады. Байланыс деректері шифрланған түрде сақталады. Өзекті келісім жіберу алдында көрсетіледі. Сақтау мерзімдері іске қосылғанға дейін бекітілуі тиіс.'}
            </p>
            <a href={href('booking')}>{t.booking}</a>
          </section>
        )}
        {!['home', 'services', 'doctors', 'booking', 'contacts', 'privacy'].includes(page) && (
          <a className="button" href={href('home')}>
            {t.back}
          </a>
        )}
      </main>
      <footer className="footer">
        <a className="brand" href={href('home')}>
          ALATAU CLINIC
        </a>
        <p>{t.synthetic}</p>
        <a href={href('privacy')}>{t.privacy}</a>
      </footer>
      <nav className="mobile-nav" aria-label={t.booking}>
        {nav.map(([p, label], i) => (
          <a key={p} aria-current={page === p ? 'page' : undefined} href={href(p)}>
            <span aria-hidden="true">{['⌂', '✚', '♧', '▦', '◇'][i]}</span>
            {label}
          </a>
        ))}
      </nav>
    </>
  );
}
