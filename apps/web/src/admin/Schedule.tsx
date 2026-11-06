import { translate as t, labelName, adminLocale } from './i18n';
import { useLoad } from './useLoad';
import { useState } from 'react';
import { doctors, availabilitySchema, request } from '../api/clinic';
import {
  adminRequest,
  pageSchema,
  windowSchema,
  appointmentSchema,
  clinicDay,
  range,
  time,
  message,
  statuses,
  clinicZone,
  localValue,
  localToIso,
} from './api';
import { LoadState, Confirm, Pager } from './ui';
export function Schedule() {
  const [date, setDate] = useState(clinicDay),
    [days, setDays] = useState(1),
    [doctor, setDoctor] = useState(''),
    [service, setService] = useState(''),
    [page, setPage] = useState(1),
    [edit, setEdit] = useState<{
      id: string;
      doctorId: string;
      startsAt: string;
      endsAt: string;
    } | null>(null),
    [remove, setRemove] = useState(''),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const team = useLoad((signal) => doctors(signal), ['schedule-doctors']),
    query = new URLSearchParams({
      ...range(date, days),
      page: String(page),
      pageSize: '20',
      ...(doctor ? { doctorId: doctor } : {}),
    });
  const windows = useLoad(
    (signal) =>
      adminRequest('/admin/availability-windows?' + query, 'GET', undefined, signal).then((v) =>
        pageSchema(windowSchema).parse(v),
      ),
    ['windows', date, days, doctor, page],
  );
  const bookings = useLoad(
    (signal) =>
      adminRequest('/admin/appointments?' + query, 'GET', undefined, signal).then((v) =>
        pageSchema(appointmentSchema).parse(v),
      ),
    ['calendar', date, days, doctor, page],
  );
  const slots = useLoad(
    (signal) =>
      doctor && service
        ? request(
            '/availability?' + new URLSearchParams({ doctorId: doctor, serviceId: service, date }),
            { signal },
          ).then((v) => availabilitySchema.parse(v))
        : Promise.resolve(null),
    ['schedule-free', date, doctor, service],
  );
  const local = localValue;
  function reload() {
    windows.refresh();
    bookings.refresh();
    slots.refresh();
  }
  return (
    <>
      <h1>{t('Календарь врачей')}</h1>
      <p>
        {t('Время клиники:')} {clinicZone()}.{' '}
        {t('Для свободных интервалов выберите врача и услугу.')}
      </p>
      <section className="panel admin-filters">
        <label>
          {t('Дата календаря')}
          <input
            type="date"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          {t('Период')}
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setPage(1);
            }}
          >
            <option value={1}>{t('День')}</option>
            <option value={7}>{t('Неделя')}</option>
          </select>
        </label>
        <label>
          {t('Врач календаря')}
          <select
            aria-label={t('Врач календаря')}
            value={doctor}
            onChange={(e) => {
              setDoctor(e.target.value);
              setService('');
              setPage(1);
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
          {t('Услуга для доступности')}
          <select
            aria-label={t('Услуга для доступности')}
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="">{t('Выберите услугу')}</option>
            {team.data
              ?.find((d) => d.id === doctor)
              ?.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {labelName(s)}
                </option>
              ))}
          </select>
        </label>
      </section>
      <div className="admin-two">
        <section className="panel">
          <h2>{t('Рабочие интервалы')}</h2>
          <LoadState {...windows} retry={windows.refresh} />
          {windows.data?.items.map((w) => (
            <article className="admin-row" key={w.id}>
              <strong>
                {team.data?.find((d) => d.id === w.doctorId)?.[
                  adminLocale() === 'kk' ? 'nameKk' : 'nameRu'
                ] ?? w.doctorId}
              </strong>
              <p>
                {time(w.startsAt)} — {time(w.endsAt)}
              </p>
              <button
                onClick={() => {
                  setEdit(w);
                  setDoctor(w.doctorId);
                  setStart(local(w.startsAt));
                  setEnd(local(w.endsAt));
                }}
              >
                {t('Изменить интервал')}
              </button>
              <button className="danger" onClick={() => setRemove(w.id)}>
                {t('Удалить интервал')}
              </button>
            </article>
          ))}
          {windows.data && !windows.data.items.length && <p>{t('Рабочих интервалов нет.')}</p>}
          {windows.data && (
            <Pager page={page} total={windows.data.pagination.total} setPage={setPage} />
          )}
        </section>
        <section className="panel">
          <h2>{t('Приёмы за период')}</h2>
          <LoadState {...bookings} retry={bookings.refresh} />
          {bookings.data?.items.map((b) => (
            <article className="admin-row" key={b.id}>
              <strong>
                {time(b.startsAt)} — {time(b.endsAt)}
              </strong>
              <p>
                {statuses[b.status]} ·{' '}
                {(adminLocale() === 'kk' ? b.doctorNameKk : b.doctorNameRu) ??
                  team.data?.find((d) => d.id === b.doctorId)?.[
                    adminLocale() === 'kk' ? 'nameKk' : 'nameRu'
                  ] ??
                  b.doctorId}
              </p>
            </article>
          ))}
          {bookings.data && (
            <Pager page={page} total={bookings.data.pagination.total} setPage={setPage} />
          )}
          <h3>{t('Свободное время выбранного дня')}</h3>
          <LoadState {...slots} retry={slots.refresh} />
          <div className="slots">
            {slots.data?.slots.map((s) => (
              <span className="badge" key={s.startsAt}>
                {time(s.startsAt)}
              </span>
            ))}
          </div>
          {slots.data && !slots.data.slots.length && <p>{t('Свободного времени нет.')}</p>}
        </section>
      </div>
      <form
        className="panel admin-editor"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!doctor || !start || !end) {
            setError(t('Выберите врача и границы интервала.'));
            return;
          }
          setBusy(true);
          void adminRequest(
            '/admin/availability-windows' + (edit ? '/' + edit.id : ''),
            edit ? 'PATCH' : 'POST',
            {
              doctorId: edit?.doctorId ?? doctor,
              startsAt: localToIso(start),
              endsAt: localToIso(end),
            },
          )
            .then(() => {
              setEdit(null);
              setStart('');
              setEnd('');
              reload();
            })
            .catch((e) => setError(message(e)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{edit ? t('Изменение интервала') : t('Добавить рабочий интервал')}</h2>
        <p>
          {t('Перерыв — разрыв между интервалами. Занятые приёмы нельзя оставлять вне расписания.')}
        </p>
        <label>
          {t('Начало')}
          <input
            type="datetime-local"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          {t('Окончание')}
          <input
            type="datetime-local"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="admin-actions">
          {edit && (
            <button type="button" onClick={() => setEdit(null)}>
              {t('Отменить редактирование')}
            </button>
          )}
          <button className="button" disabled={busy}>
            {edit ? t('Сохранить интервал') : t('Добавить интервал')}
          </button>
        </div>
      </form>
      {remove && (
        <Confirm
          title={t('Удалить рабочий интервал?')}
          onClose={() => setRemove('')}
          onConfirm={async () => {
            await adminRequest('/admin/availability-windows/' + remove, 'DELETE', {});
            setRemove('');
            reload();
          }}
        >
          <p>{t('Операция отклоняется, если существующий приём останется вне работы.')}</p>
        </Confirm>
      )}
    </>
  );
}
