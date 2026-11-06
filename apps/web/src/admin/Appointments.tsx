import { translate as t, labelName, adminLocale } from './i18n';
import { useLoad } from './useLoad';
import { useState, useRef } from 'react';
import {
  doctors,
  services,
  availabilitySchema,
  request,
  newKey,
  ApiError,
  resultSchema,
} from '../api/clinic';
import {
  adminRequest,
  appointmentSchema,
  detailSchema,
  pageSchema,
  statuses,
  range,
  clinicDay,
  time,
  message,
} from './api';
import { LoadState, Pager, Confirm } from './ui';
export function Appointments({ admin }: { admin: boolean }) {
  const [date, setDate] = useState(clinicDay),
    [doctor, setDoctor] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(''),
    [search, setSearch] = useState(''),
    [creating, setCreating] = useState(false),
    [created, setCreated] = useState('');
  const team = useLoad((signal) => doctors(signal), ['doctors-public']),
    catalog = useLoad((signal) => services(signal), ['services-public']);
  const query = new URLSearchParams({
    ...range(date),
    page: String(page),
    pageSize: '20',
    ...(doctor ? { doctorId: doctor } : {}),
    ...(status ? { status } : {}),
  });
  const rows = useLoad(
    (signal) =>
      adminRequest('/admin/appointments?' + query, 'GET', undefined, signal).then((v) =>
        pageSchema(appointmentSchema).parse(v),
      ),
    ['appointments', date, doctor, status, page],
  );
  function reset() {
    setPage(1);
    setSelected('');
  }
  return (
    <>
      <div className="admin-title">
        <div>
          <h1>{t('Записи на приём')}</h1>
          <p>{t('Заявки, подтверждение и работа с расписанием')}</p>
        </div>
        <button
          onClick={() => {
            rows.refresh();
            setSelected('');
          }}
        >
          {t('Обновить')}
        </button>
      </div>
      <button
        className="button"
        onClick={() => {
          setCreating(true);
          setCreated('');
        }}
      >
        {t('Создать запись по коду пациента')}
      </button>
      {created && (
        <p role="status">
          {t('Заявка создана: ')}
          {created}
        </p>
      )}
      {creating && (
        <Reschedule
          close={() => setCreating(false)}
          done={(day, reference) => {
            setCreating(false);
            setDate(day);
            setPage(1);
            setStatus('');
            setDoctor('');
            setCreated(reference ?? '');
            rows.refresh();
          }}
        />
      )}
      <div className="admin-metrics">
        <div className="panel">
          <span>{t('Найдено записей')}</span>
          <strong>{rows.data?.pagination.total ?? '—'}</strong>
        </div>
        <div className="panel">
          <span>{t('Фильтр статуса')}</span>
          <strong>{status ? statuses[status as keyof typeof statuses] : t('Все статусы')}</strong>
        </div>
      </div>
      <section className="panel admin-filters">
        <label>
          {t('Дата')}
          <input
            type="date"
            required
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setDate(e.target.value);
                reset();
              }
            }}
          />
        </label>
        <label>
          {t('Врач')}
          <select
            value={doctor}
            onChange={(e) => {
              setDoctor(e.target.value);
              reset();
            }}
          >
            <option value="">{t('Все врачи')}</option>
            {team.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {labelName(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Статус')}
          <select
            aria-label={t('Статус')}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              reset();
            }}
          >
            <option value="">{t('Все статусы')}</option>
            {Object.entries(statuses).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Номер на текущей странице')}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={50}
          />
        </label>
      </section>
      <LoadState {...rows} retry={rows.refresh} />
      <div className="admin-workspace">
        <section className="panel">
          <h2>{t('Список приёмов')}</h2>
          {rows.data && !rows.data.items.length && <p>{t('На выбранную дату записей нет.')}</p>}
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('Время')}</th>
                  <th>{t('Номер / статус')}</th>
                  <th>{t('Врач и услуга')}</th>
                  <th>{t('Цена')}</th>
                  <th>{t('Действие')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.data?.items
                  .filter((r) => r.reference.toLowerCase().includes(search.toLowerCase()))
                  .map((r) => (
                    <tr key={r.id}>
                      <td>{time(r.startsAt)}</td>
                      <td>
                        <span className="admin-reference">{r.reference}</span>
                        <span className={'status status-' + r.status}>{statuses[r.status]}</span>
                      </td>
                      <td>
                        {(adminLocale() === 'kk' ? r.doctorNameKk : r.doctorNameRu) ??
                          team.data?.find((d) => d.id === r.doctorId)?.[
                            adminLocale() === 'kk' ? 'nameKk' : 'nameRu'
                          ] ??
                          r.doctorId}
                        <small>
                          {(adminLocale() === 'kk' ? r.serviceNameKk : r.serviceNameRu) ??
                            catalog.data?.find((s) => s.id === r.serviceId)?.[
                              adminLocale() === 'kk' ? 'nameKk' : 'nameRu'
                            ] ??
                            r.serviceId}
                        </small>
                      </td>
                      <td>{r.priceKzt} ₸</td>
                      <td>
                        <button
                          aria-label={t('Открыть ') + r.reference}
                          onClick={() => setSelected(r.id)}
                        >
                          {t('Карточка')}
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {rows.data && (
            <Pager
              page={page}
              total={rows.data.pagination.total}
              setPage={(n) => {
                setPage(n);
                setSelected('');
              }}
            />
          )}
        </section>
        {selected && (
          <Detail
            key={selected}
            id={selected}
            admin={admin}
            refresh={rows.refresh}
            close={() => setSelected('')}
          />
        )}
      </div>
    </>
  );
}
function Detail({
  id,
  admin,
  refresh,
  close,
}: {
  id: string;
  admin: boolean;
  refresh: () => void;
  close: () => void;
}) {
  const detail = useLoad(
    (signal) =>
      adminRequest('/admin/appointments/' + id, 'GET', undefined, signal).then((v) =>
        detailSchema.parse(v),
      ),
    ['detail', id],
  );
  const [operation, setOperation] = useState(''),
    [verified, setVerified] = useState(false),
    [now] = useState(() => Date.now());
  const row = detail.data;
  const success = () => {
    setOperation('');
    detail.refresh();
    refresh();
  };
  return (
    <aside className="panel admin-detail">
      <button onClick={close}>{t('Закрыть карточку')}</button>
      <LoadState {...detail} retry={detail.refresh} />
      {row && (
        <>
          <h2>{t('Карточка заявки')}</h2>
          <p className="admin-reference">{row.reference}</p>
          <span className={'status status-' + row.status}>{statuses[row.status]}</span>
          <h3>{row.contacts?.name ?? t('Контакты удалены')}</h3>
          <p>{row.contacts?.phone}</p>
          <p>
            {adminLocale() === 'kk' ? row.doctorNameKk : row.doctorNameRu}
            <br />
            {adminLocale() === 'kk' ? row.serviceNameKk : row.serviceNameRu}
          </p>
          <p>
            {time(row.startsAt)} — {time(row.endsAt)}
            <br />
            {row.priceKzt} ₸ · {row.durationMinutes}
            {t('мин')}
          </p>
          <p>
            {t('Версия: ')}
            {row.version}
            {t('. Чтение контактов записано в аудит.')}
          </p>
          <div className="admin-actions vertical">
            {row.status === 'PENDING' && new Date(row.startsAt).getTime() > now && (
              <button className="button" onClick={() => setOperation('CONFIRMED')}>
                {t('Подтвердить запись')}
              </button>
            )}
            {['PENDING', 'CONFIRMED'].includes(row.status) && (
              <>
                <button onClick={() => setOperation('reschedule')}>{t('Перенести время')}</button>
                <button className="danger" onClick={() => setOperation('CANCELLED')}>
                  {t('Отменить запись')}
                </button>
              </>
            )}
            {row.status === 'CONFIRMED' && new Date(row.endsAt).getTime() <= now && (
              <>
                <button onClick={() => setOperation('COMPLETED')}>{t('Завершить приём')}</button>
                <button onClick={() => setOperation('NO_SHOW')}>{t('Отметить неявку')}</button>
              </>
            )}
            {admin && !row.consent?.withdrawnAt && (
              <button
                onClick={() => {
                  setVerified(false);
                  setOperation('withdraw');
                }}
              >
                {t('Зафиксировать отзыв согласия')}
              </button>
            )}
            <button onClick={detail.refresh}>{t('Обновить карточку')}</button>
          </div>
          {row.consent?.withdrawnAt && (
            <p>
              {t('Отзыв согласия:')}
              {time(row.consent.withdrawnAt)}
            </p>
          )}
          {operation === 'reschedule' ? (
            <Reschedule row={row} done={success} close={() => setOperation('')} />
          ) : (
            operation && (
              <Confirm
                title={
                  operation === 'withdraw'
                    ? t('Проверенный отзыв согласия')
                    : statuses[operation as keyof typeof statuses]
                }
                onClose={() => setOperation('')}
                onConfirm={async () => {
                  if (operation === 'withdraw') {
                    if (!verified) throw new Error('Identity verification required');
                    await adminRequest(
                      '/admin/appointments/' + id + '/consent-withdrawal',
                      'POST',
                      { version: row.version, confirmedIdentity: true },
                    );
                  } else
                    await adminRequest('/admin/appointments/' + id, 'PATCH', {
                      action: 'status',
                      version: row.version,
                      status: operation,
                    });
                  success();
                }}
              >
                <p>{t('Проверьте номер и время заявки. Изменения фиксируются в аудите.')}</p>
                {operation === 'withdraw' && (
                  <>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={verified}
                        onChange={(e) => setVerified(e.target.checked)}
                      />
                      {t('Личность и обращение проверены')}
                    </label>
                    <p>
                      {t(
                        'Фиксация не удаляет и не отменяет запись автоматически. Дальнейшие действия — по утверждённому регламенту.',
                      )}
                    </p>
                  </>
                )}
              </Confirm>
            )
          )}
        </>
      )}
    </aside>
  );
}
function Reschedule({
  row,
  done,
  close,
}: {
  row?: { id: string; doctorId: string; serviceId: string; version: number };
  done: (date: string, reference?: string) => void;
  close: () => void;
}) {
  const team = useLoad((signal) => doctors(signal), ['move-doctors']),
    [doctor, setDoctor] = useState(row?.doctorId ?? ''),
    [service, setService] = useState(row?.serviceId ?? ''),
    [date, setDate] = useState(clinicDay),
    [slot, setSlot] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [code, setCode] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ key: string; body: unknown } | null>(null);
  const selected = team.data?.find((d) => d.id === doctor),
    available = !!selected?.services.some((s) => s.id === service);
  const slots = useLoad(
    (signal) =>
      available
        ? request(
            '/availability?' + new URLSearchParams({ doctorId: doctor, serviceId: service, date }),
            { signal },
          ).then((v) => availabilitySchema.parse(v))
        : Promise.resolve(null),
    ['move-slots', doctor, service, date, available],
  );
  return (
    <section className="admin-inline">
      <h3>{row ? t('Перенос записи') : t('Запись сотрудником')}</h3>
      <p>
        {row
          ? t('При конфликте исходный приём сохранится.')
          : t(
              'Пациент самостоятельно подтверждает согласие. Код действует 5 минут. Не заполняйте согласие вместо пациента.',
            )}
      </p>
      {!row && (
        <p>
          <a href={'/' + adminLocale() + '/phone-consent'}>{t('Страница согласия для пациента')}</a>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!uncertain && !slots.data?.slots.some((s) => s.startsAt === slot)) {
            setError(t('Выберите доступное время.'));
            return;
          }
          setBusy(true);
          if (!row) {
            if (!attempt.current)
              attempt.current = {
                key: newKey(),
                body: {
                  doctorId: doctor,
                  serviceId: service,
                  startsAt: slot,
                  expectedPriceKzt: slots.data?.priceKzt,
                  expectedDurationMinutes: slots.data?.durationMinutes,
                  consentCode: code,
                },
              };
            void adminRequest('/admin/appointments', 'POST', attempt.current.body, undefined, {
              'idempotency-key': attempt.current.key,
            })
              .then((v) => {
                const result = resultSchema.parse(v);
                attempt.current = null;
                done(date, result.reference);
              })
              .catch((e) => {
                setError(message(e));
                if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
                  attempt.current = null;
                  setUncertain(false);
                  setSlot('');
                  if (e.code === 'CONSENT_CODE_UNAVAILABLE' || e.code === 'CONSENT_CHANGED')
                    setCode('');
                  slots.refresh();
                } else setUncertain(true);
              })
              .finally(() => setBusy(false));
            return;
          }
          if (!slots.data) {
            setBusy(false);
            setError(t('Выберите доступное время.'));
            return;
          }
          void adminRequest('/admin/appointments/' + row.id, 'PATCH', {
            action: 'reschedule',
            version: row.version,
            doctorId: doctor,
            serviceId: service,
            startsAt: slot,
            expectedPriceKzt: slots.data.priceKzt,
            expectedDurationMinutes: slots.data.durationMinutes,
          })
            .then(() => done(date))
            .catch((e) => {
              setError(message(e));
              setSlot('');
              slots.refresh();
            })
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy || uncertain}>
          {!row && (
            <label>
              {t('Код согласия пациента')}
              <input
                required
                pattern="[a-f0-9]{32}"
                maxLength={32}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <label>
            {row ? t('Врач для переноса') : t('Врач для новой записи')}
            <select
              aria-label={row ? t('Врач для переноса') : t('Врач для новой записи')}
              required
              value={doctor}
              onChange={(e) => {
                setDoctor(e.target.value);
                setService('');
                setSlot('');
              }}
            >
              <option value="">{t('Выберите врача')}</option>
              {team.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {labelName(d)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {row ? t('Услуга для переноса') : t('Услуга для новой записи')}
            <select
              aria-label={row ? t('Услуга для переноса') : t('Услуга для новой записи')}
              required
              value={service}
              onChange={(e) => {
                setService(e.target.value);
                setSlot('');
              }}
            >
              <option value="">{t('Выберите услугу')}</option>
              {selected?.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {labelName(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {row ? t('Новая дата') : t('Дата новой записи')}
            <input
              type="date"
              required
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
                setSlot('');
              }}
            />
          </label>
          <LoadState {...slots} retry={slots.refresh} />
          <div className="slots">
            {slots.data?.slots.map((s) => (
              <button
                type="button"
                key={s.startsAt}
                aria-pressed={slot === s.startsAt}
                onClick={() => setSlot(s.startsAt)}
              >
                {time(s.startsAt)}
              </button>
            ))}
          </div>
          {slots.data && !slots.data.slots.length && <p>{t('Нет свободного времени.')}</p>}
          {slots.data && (
            <p>
              {t('Новые условия:')}
              {slots.data.priceKzt} ₸ · {slots.data.durationMinutes}
              {t('мин')}
            </p>
          )}
        </fieldset>
        {uncertain && (
          <p role="alert">
            {t(
              'Ответ сервера не получен. Повторите ту же попытку; новая запись не создаётся при идентичном повторе.',
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="admin-actions">
          <button type="button" onClick={close}>
            {t('Назад')}
          </button>
          <button className="button" disabled={busy}>
            {row ? t('Сохранить перенос') : uncertain ? t('Повторить') : t('Создать запись')}
          </button>
        </div>
      </form>
    </section>
  );
}
