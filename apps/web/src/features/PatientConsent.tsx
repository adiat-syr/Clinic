import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod/mini';
import { request, consentSchema, validateContacts, ApiError } from '../api/clinic';
import { copy, type Locale } from '../app/i18n';

export function PatientConsent({ locale }: { locale: Locale }) {
  const t = copy[locale],
    ru = locale === 'ru';
  const [name, setName] = useState(''),
    [phone, setPhone] = useState(''),
    [accepted, setAccepted] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<{
      code: string;
      expiresAt: string;
      documentVersion: string;
    } | null>(null);
  const document = useQuery({
    queryKey: ['patient-code-consent', locale],
    retry: false,
    gcTime: 0,
    queryFn: ({ signal }) =>
      request('/consent-documents/current?locale=' + locale, { signal }).then((v) =>
        consentSchema.parse(v),
      ),
  });
  const consentKey = document.data ? document.data.id + ':' + document.data.contentSha256 : '';
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(
      () => {
        setReceipt(null);
        setAccepted('');
        setError(
          ru
            ? 'Срок кода истёк. Подтвердите согласие заново.'
            : 'Код мерзімі аяқталды. Келісімді қайта растаңыз.',
        );
      },
      Math.max(0, Date.parse(receipt.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [receipt, ru]);
  return (
    <section className="panel booking-form">
      <h1>{ru ? 'Согласие для записи с сотрудником' : 'Қызметкер арқылы жазылуға келісім'}</h1>
      <p>
        {ru
          ? 'Дополнительный способ для телефонного обращения. Основной способ — самостоятельная онлайн-запись. Только синтетические данные; юридическая применимость процедуры не проверена.'
          : 'Телефон арқылы жүгінуге арналған қосымша тәсіл. Негізгі тәсіл — өз бетіңізше онлайн жазылу. Тек синтетикалық деректер; рәсімнің заңдық жарамдылығы тексерілмеген.'}
      </p>
      <a href={'/' + locale + '/booking'}>{t.booking}</a>
      <p>
        {ru
          ? 'Согласие подтверждает сам посетитель. Сотрудник не должен заполнять эту форму вместо вас. Код не подтверждает личность и не является записью на приём.'
          : 'Келісімді келушінің өзі растайды. Қызметкер бұл нысанды сіздің орныңызға толтырмауы керек. Код жеке басты растамайды және қабылдауға жазылу болып саналмайды.'}
      </p>
      {receipt ? (
        <div role="status">
          <h2>{ru ? 'Передайте код сотруднику' : 'Кодты қызметкерге айтыңыз'}</h2>
          <output aria-label={ru ? 'Одноразовый код согласия' : 'Бір реттік келісім коды'}>
            {receipt.code}
          </output>
          <p>
            {ru ? 'Один раз, 5 минут. Версия согласия: ' : 'Бір рет, 5 минут. Келісім нұсқасы: '}
            {receipt.documentVersion}
          </p>
          <p>
            {ru
              ? 'Не размещайте код в URL, чате или общих скриншотах. После использования он не создаст ещё одну запись.'
              : 'Кодты URL, чат немесе ортақ скриншоттарға салмаңыз. Қолданылған код екінші жазылуды жасамайды.'}
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            if (!document.data || accepted !== consentKey || !validateContacts(name, phone, true)) {
              setError(t.invalid);
              return;
            }
            setBusy(true);
            void request('/auth/csrf')
              .then((v) => z.object({ csrfToken: z.string() }).parse(v))
              .then((csrf) =>
                request('/patient-consent-codes', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.csrfToken },
                  body: JSON.stringify({
                    contacts: { name: name.trim(), phone },
                    consent: { documentId: document.data?.id, locale, accepted: true },
                  }),
                }),
              )
              .then((v) => {
                setReceipt(
                  z
                    .object({
                      code: z.string(),
                      expiresAt: z.string(),
                      documentVersion: z.string(),
                    })
                    .parse(v),
                );
                setName('');
                setPhone('');
                setAccepted('');
              })
              .catch((e) => {
                setError(
                  e instanceof ApiError && e.code === 'PATIENT_ACTION_REQUIRED'
                    ? ru
                      ? 'Согласие нельзя выдавать из сессии сотрудника. Это отдельное действие посетителя.'
                      : 'Қызметкер сеансынан келісім беруге болмайды. Бұл келушінің бөлек әрекеті.'
                    : t.error,
                );
                if (e instanceof ApiError && e.code === 'CONSENT_CHANGED') {
                  setAccepted('');
                  void document.refetch();
                }
              })
              .finally(() => setBusy(false));
          }}
        >
          <fieldset disabled={busy}>
            <legend>{t.name}</legend>
            <label>
              {t.name}
              <input
                required
                autoComplete="name"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {t.phone}
              <input
                required
                type="tel"
                autoComplete="tel"
                maxLength={32}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            {document.isPending && <p role="status">{t.loading}</p>}
            {document.isError && (
              <p role="alert">
                {t.error}
                <button type="button" onClick={() => void document.refetch()}>
                  {t.retry}
                </button>
              </p>
            )}
            {document.data && (
              <>
                <h2>
                  {t.consent} · {document.data.version}
                </h2>
                <p className="consent-text">{document.data.text}</p>
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
            <button className="button" disabled={!document.data || accepted !== consentKey}>
              {busy ? t.loading : ru ? 'Получить одноразовый код' : 'Бір реттік кодты алу'}
            </button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
