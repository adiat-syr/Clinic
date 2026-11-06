import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { doctors, services, clinicProfile, type Service, type Doctor } from '../api/clinic';
import { Booking } from '../features/Booking';
import { PatientConsent } from '../features/PatientConsent';
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
  const info = useQuery({
    queryKey: ['clinic'],
    queryFn: ({ signal }) => clinicProfile(signal),
    retry: false,
  });
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
  if (!info.data)
    return (
      <main className="container">
        <p role={info.isError ? 'alert' : 'status'}>{info.isError ? t.error : t.loading}</p>
        {info.isError && <button onClick={() => void info.refetch()}>{t.retry}</button>}
      </main>
    );
  const clinic = info.data;
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
        {t.skip}
      </a>
      <header className="site-header">
        <a href={href('home')} className="brand">
          <span className="brand-icon" aria-hidden="true">
            ✚
          </span>
          <span>
            {clinic.logoAsset && <img src={clinic.logoAsset} alt="" width="36" height="36" />}
            {clinic.name[locale]}
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
      {clinic.synthetic && <div className="environment">{t.synthetic}</div>}
      <main id="main" className="container">
        {page === 'home' && (
          <section className="hero">
            <div>
              <span className="eyebrow">{clinic.name[locale]}</span>
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
              <div className="art-caption">{clinic.name[locale]}</div>
            </div>
          </section>
        )}
        {page !== 'home' && page !== 'booking' && page !== 'phone-consent' && <h1>{title}</h1>}
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
        {!busy && !error && page === 'booking' && !clinic.bookingEnabled && (
          <section className="panel">
            <h1>{t.booking}</h1>
            <p>
              {locale === 'ru'
                ? 'Онлайн-запись временно недоступна. Свяжитесь с регистратурой.'
                : 'Онлайн жазылу уақытша қолжетімсіз. Тіркеу бөліміне хабарласыңыз.'}
            </p>
            <a className="button" href={href('contacts')}>
              {t.contacts}
            </a>
          </section>
        )}
        {!busy && !error && page === 'booking' && clinic.bookingEnabled && (
          <Booking
            timeZone={clinic.timeZone}
            services={catalog.data ?? []}
            doctors={team.data ?? []}
            locale={locale}
          />
        )}
        {page === 'contacts' && (
          <div className="two-columns">
            <section className="panel">
              <h2>{clinic.name[locale]}</h2>
              {clinic.synthetic && <p>{t.synthetic}</p>}
              <p>{clinic.address[locale]}</p>
              <p>{clinic.hours[locale]}</p>
              <p>{clinic.license[locale]}</p>
              <p>
                <a href={'tel:' + clinic.phone}>{clinic.phone}</a>
              </p>
              <p>
                <a href={'mailto:' + clinic.email}>{clinic.email}</a>
              </p>
              {clinic.synthetic && (
                <p>
                  {locale === 'ru'
                    ? 'Реквизиты, адрес и телефон реальной клиники ещё не утверждены. Эта версия предназначена только для проверки записи с вымышленными контактами.'
                    : 'Нақты клиниканың мекенжайы мен телефоны әлі бекітілген жоқ. Бұл нұсқа тек ойдан шығарылған деректермен тексеруге арналған.'}
                </p>
              )}
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
            {clinic.synthetic && <p>{t.synthetic}</p>}
            <p>{t.safe}</p>
            <p className="consent-text">{clinic.privacy[locale]}</p>
            <a href={href('booking')}>{t.booking}</a>
          </section>
        )}
        {page === 'phone-consent' && (
          <PatientConsent
            locale={locale}
            synthetic={clinic.synthetic}
            available={clinic.bookingEnabled && clinic.phoneConsentEnabled}
          />
        )}
        {![
          'home',
          'services',
          'doctors',
          'booking',
          'contacts',
          'privacy',
          'phone-consent',
        ].includes(page) && (
          <a className="button" href={href('home')}>
            {t.back}
          </a>
        )}
      </main>
      <footer className="footer">
        <a className="brand" href={href('home')}>
          {clinic.name[locale]}
        </a>
        {clinic.synthetic && <p>{t.synthetic}</p>}
        <a href={href('privacy')}>{t.privacy}</a>
        <a href={href('phone-consent')}>
          {locale === 'ru'
            ? 'Согласие для записи с сотрудником'
            : 'Қызметкер арқылы жазылуға келісім'}
        </a>
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
