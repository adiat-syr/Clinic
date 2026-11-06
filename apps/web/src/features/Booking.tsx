import { useRef, useState, useEffect, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  availabilitySchema,
  consentSchema,
  newKey,
  request,
  submitBooking,
  validateContacts,
  type Service,
  type Doctor,
  type BookingResult,
} from '../api/clinic';
import { copy, type Locale } from '../app/i18n';
export function Booking({
  services,
  doctors,
  locale,
  timeZone = 'Asia/Almaty',
}: {
  services: Service[];
  doctors: Doctor[];
  locale: Locale;
  timeZone?: string;
}) {
  const t = copy[locale],
    params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const [serviceId, setService] = useState(params.get('service') ?? ''),
    [doctorId, setDoctor] = useState(params.get('doctor') ?? ''),
    [date, setDate] = useState(''),
    [slot, setSlot] = useState(''),
    [name, setName] = useState(''),
    [phone, setPhone] = useState(''),
    [accepted, setAccepted] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [result, setResult] = useState<BookingResult | null>(null);
  const [today] = useState(() => new Date());
  const attempt = useRef<{ key: string; body: unknown } | null>(null);
  const service = services.find((s) => s.id === serviceId),
    eligible = doctors.filter((d) => d.services.some((s) => s.id === serviceId)),
    doctor = eligible.find((d) => d.id === doctorId);
  const availability = useQuery({
    queryKey: ['availability', serviceId, doctorId, date],
    enabled: !!service && !!doctor && !!date,
    retry: false,
    queryFn: ({ signal }) =>
      request(`/availability?${new URLSearchParams({ serviceId, doctorId, date })}`, {
        signal,
      }).then((x) => availabilitySchema.parse(x)),
  });
  const consent = useQuery({
    queryKey: ['consent', locale],
    retry: false,
    queryFn: ({ signal }) =>
      request(`/consent-documents/current?locale=${locale}`, { signal }).then((x) =>
        consentSchema.parse(x),
      ),
  });
  useEffect(() => {
    if (!busy && !uncertain) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy, uncertain]);
  const consentKey = consent.data ? `${consent.data.id}:${consent.data.version}` : '';
  const zone = availability.data?.timeZone ?? timeZone;
  const time = (v: string) =>
    new Intl.DateTimeFormat(locale === 'ru' ? 'ru-KZ' : 'kk-KZ', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(v));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setMessage('');
    if (!attempt.current) {
      if (
        !validateContacts(name, phone, !!consentKey && accepted === consentKey) ||
        !service ||
        !doctor ||
        !slot ||
        !availability.data?.slots.some((x) => x.startsAt === slot)
      ) {
        setMessage(t.invalid);
        return;
      }
      attempt.current = {
        key: newKey(),
        body: {
          doctorId,
          serviceId,
          startsAt: slot,
          expectedPriceKzt: availability.data.priceKzt,
          expectedDurationMinutes: availability.data.durationMinutes,
          contacts: { name: name.trim(), phone },
          consent: { documentId: consent.data?.id, accepted: true, locale },
        },
      };
    }
    setBusy(true);
    try {
      const r = await submitBooking(attempt.current.body, attempt.current.key);
      setResult(r);
      setName('');
      setPhone('');
      setAccepted('');
      attempt.current = null;
      setUncertain(false);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'API_ERROR',
        definitive = error instanceof ApiError && [400, 403, 409, 429].includes(error.status);
      if (definitive) {
        attempt.current = null;
        setUncertain(false);
      } else setUncertain(true);
      if (code === 'SLOT_UNAVAILABLE' || code === 'OFFER_CHANGED') {
        setSlot('');
        void availability.refetch();
        setMessage(code === 'SLOT_UNAVAILABLE' ? t.occupied : t.offer);
      } else if (code === 'CONSENT_CHANGED') {
        setAccepted('');
        void consent.refetch();
        setMessage(t.consentChanged);
      } else setMessage(code === 'RATE_LIMITED' ? t.limit : definitive ? t.error : t.network);
    } finally {
      setBusy(false);
    }
  }
  if (result)
    return (
      <section className="panel result" role="status">
        <span className="success-mark" aria-hidden="true">
          ✓
        </span>
        <h1>{t.success}</h1>
        <p>
          {result.status === 'PENDING'
            ? t.pending
            : (locale === 'ru'
                ? {
                    CONFIRMED: 'Приём подтверждён',
                    CANCELLED: 'Запись отменена',
                    COMPLETED: 'Приём завершён',
                    NO_SHOW: 'Приём не состоялся',
                  }
                : {
                    CONFIRMED: 'Қабылдау расталды',
                    CANCELLED: 'Жазылу жойылды',
                    COMPLETED: 'Қабылдау аяқталды',
                    NO_SHOW: 'Қабылдау өтпеді',
                  })[result.status as 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW']}
        </p>
        <p>
          {t.reference}
          <br />
          <strong className="reference">{result.reference}</strong>
        </p>
        <p>
          {new Intl.DateTimeFormat(locale === 'ru' ? 'ru-KZ' : 'kk-KZ', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: zone,
          }).format(new Date(result.startsAt))}{' '}
          · {zone}
        </p>
        <h2>{t.change}</h2>
        <p>{t.changeText}</p>
        <a className="button" href={`/${locale}/contacts`}>
          {t.contacts}
        </a>
      </section>
    );
  return (
    <>
      <h1>{t.booking}</h1>
      <p className="lead">{t.intro}</p>
      <ol className="steps">
        <li>1 · {t.service}</li>
        <li>2 · {t.time}</li>
        <li>3 · {t.name}</li>
      </ol>
      <form onSubmit={submit} noValidate className="booking-layout">
        <div>
          <fieldset disabled={busy || uncertain} className="panel">
            <legend>1 · {t.service}</legend>
            <label>
              {t.service}
              <select
                aria-label={t.service}
                required
                value={serviceId}
                onChange={(e) => {
                  setService(e.target.value);
                  setDoctor('');
                  setSlot('');
                }}
              >
                <option value="">—</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {locale === 'ru' ? s.nameRu : s.nameKk}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.doctor}
              <select
                aria-label={t.doctor}
                required
                value={doctorId}
                onChange={(e) => {
                  setDoctor(e.target.value);
                  setSlot('');
                }}
              >
                <option value="">—</option>
                {eligible.map((d) => (
                  <option key={d.id} value={d.id}>
                    {locale === 'ru' ? d.nameRu : d.nameKk}
                  </option>
                ))}
              </select>
            </label>
            {service && !eligible.length && <p>{t.noDoctors}</p>}
          </fieldset>
          <fieldset disabled={busy || uncertain} className="panel">
            <legend>2 · {t.time}</legend>
            <label>
              {t.date}
              <input
                type="date"
                required
                value={date}
                min={new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(today)}
                max={new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10)}
                onChange={(e) => {
                  setDate(e.target.value);
                  setSlot('');
                }}
              />
            </label>
            <p className="badge">
              {t.zone}: {zone}
            </p>
            {availability.isFetching && <p role="status">{t.loading}</p>}
            {availability.isError && (
              <p role="alert">
                {t.error}{' '}
                <button type="button" onClick={() => void availability.refetch()}>
                  {t.retry}
                </button>
              </p>
            )}
            {availability.data && !availability.isFetching && (
              <>
                <h3>{t.time}</h3>
                {!availability.data.slots.length && <p>{t.empty}</p>}
                <div className="slots" role="group" aria-label={t.time}>
                  {availability.data.slots.map((s) => (
                    <button
                      key={s.startsAt}
                      type="button"
                      aria-pressed={s.startsAt === slot}
                      className={s.startsAt === slot ? 'selected' : ''}
                      onClick={() => setSlot(s.startsAt)}
                    >
                      {time(s.startsAt)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </fieldset>
          <fieldset disabled={busy || uncertain} className="panel">
            <legend>3 · {t.name}</legend>
            <p>{t.safe}</p>
            <label>
              {t.name}
              <input
                autoComplete="name"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label>
              {t.phone}
              <input
                autoComplete="tel"
                type="tel"
                inputMode="tel"
                placeholder="+7 (000) 000-00-00"
                maxLength={32}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </label>
            {consent.isPending && <p>{t.loading}</p>}
            {consent.isError && (
              <p role="alert">
                {t.error}{' '}
                <button type="button" onClick={() => void consent.refetch()}>
                  {t.retry}
                </button>
              </p>
            )}
            {consent.data && (
              <>
                <details>
                  <summary>
                    {t.consent} · {consent.data.version}
                  </summary>
                  <p className="consent-text">{consent.data.text}</p>
                </details>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={accepted === consentKey}
                    onChange={(e) => setAccepted(e.target.checked ? consentKey : '')}
                  />
                  {t.agree}
                </label>
              </>
            )}
          </fieldset>
        </div>
        <aside className="panel booking-summary">
          <h2>{t.booking}</h2>
          <p>{service ? (locale === 'ru' ? service.nameRu : service.nameKk) : t.service}</p>
          <p>{doctor ? (locale === 'ru' ? doctor.nameRu : doctor.nameKk) : t.doctor}</p>
          {availability.data && (
            <strong className="price">
              {Number(availability.data.priceKzt).toLocaleString('ru-KZ')} ₸{' '}
              <small>
                · {availability.data.durationMinutes} {t.minutes}
              </small>
            </strong>
          )}
          {slot && (
            <p>
              {date}, {time(slot)}
            </p>
          )}
          <p>{t.pending}</p>
          {message && (
            <p role="alert" className="error">
              {message}
            </p>
          )}
          <button className="button" disabled={busy} type="submit">
            {busy ? t.sending : uncertain ? t.retry : t.send}
          </button>
        </aside>
      </form>
    </>
  );
}
