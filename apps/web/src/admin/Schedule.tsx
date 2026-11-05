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
  const local = (v: string) =>
    new Date(new Date(v).getTime() + 5 * 3600000).toISOString().slice(0, 16);
  function reload() {
    windows.refresh();
    bookings.refresh();
    slots.refresh();
  }
  return (
    <>
      <h1>Календарь врачей</h1>
      <p>Время клиники: Asia/Almaty. Для свободных интервалов выберите врача и услугу.</p>
      <section className="panel admin-filters">
        <label>
          Дата календаря
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
          Период
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setPage(1);
            }}
          >
            <option value={1}>День</option>
            <option value={7}>Неделя</option>
          </select>
        </label>
        <label>
          Врач календаря
          <select
            aria-label="Врач календаря"
            value={doctor}
            onChange={(e) => {
              setDoctor(e.target.value);
              setService('');
              setPage(1);
            }}
          >
            <option value="">Все врачи</option>
            {team.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nameRu}
              </option>
            ))}
          </select>
        </label>
        <label>
          Услуга для доступности
          <select
            aria-label="Услуга для доступности"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="">Выберите услугу</option>
            {team.data
              ?.find((d) => d.id === doctor)
              ?.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nameRu}
                </option>
              ))}
          </select>
        </label>
      </section>
      <div className="admin-two">
        <section className="panel">
          <h2>Рабочие интервалы</h2>
          <LoadState {...windows} retry={windows.refresh} />
          {windows.data?.items.map((w) => (
            <article className="admin-row" key={w.id}>
              <strong>{team.data?.find((d) => d.id === w.doctorId)?.nameRu ?? w.doctorId}</strong>
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
                Изменить интервал
              </button>
              <button className="danger" onClick={() => setRemove(w.id)}>
                Удалить интервал
              </button>
            </article>
          ))}
          {windows.data && !windows.data.items.length && <p>Рабочих интервалов нет.</p>}
          {windows.data && (
            <Pager page={page} total={windows.data.pagination.total} setPage={setPage} />
          )}
        </section>
        <section className="panel">
          <h2>Приёмы за период</h2>
          <LoadState {...bookings} retry={bookings.refresh} />
          {bookings.data?.items.map((b) => (
            <article className="admin-row" key={b.id}>
              <strong>
                {time(b.startsAt)} — {time(b.endsAt)}
              </strong>
              <p>
                {statuses[b.status]} ·{' '}
                {b.doctorNameRu ??
                  team.data?.find((d) => d.id === b.doctorId)?.nameRu ??
                  b.doctorId}
              </p>
            </article>
          ))}
          {bookings.data && (
            <Pager page={page} total={bookings.data.pagination.total} setPage={setPage} />
          )}
          <h3>Свободное время выбранного дня</h3>
          <LoadState {...slots} retry={slots.refresh} />
          <div className="slots">
            {slots.data?.slots.map((s) => (
              <span className="badge" key={s.startsAt}>
                {time(s.startsAt)}
              </span>
            ))}
          </div>
          {slots.data && !slots.data.slots.length && <p>Свободного времени нет.</p>}
        </section>
      </div>
      <form
        className="panel admin-editor"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!doctor || !start || !end) {
            setError('Выберите врача и границы интервала.');
            return;
          }
          setBusy(true);
          void adminRequest(
            '/admin/availability-windows' + (edit ? '/' + edit.id : ''),
            edit ? 'PATCH' : 'POST',
            {
              doctorId: edit?.doctorId ?? doctor,
              startsAt: new Date(start + ':00+05:00').toISOString(),
              endsAt: new Date(end + ':00+05:00').toISOString(),
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
        <h2>{edit ? 'Изменение интервала' : 'Добавить рабочий интервал'}</h2>
        <p>Перерыв — разрыв между интервалами. Занятые приёмы нельзя оставлять вне расписания.</p>
        <label>
          Начало
          <input
            type="datetime-local"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          Окончание
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
              Отменить редактирование
            </button>
          )}
          <button className="button" disabled={busy}>
            {edit ? 'Сохранить интервал' : 'Добавить интервал'}
          </button>
        </div>
      </form>
      {remove && (
        <Confirm
          title="Удалить рабочий интервал?"
          onClose={() => setRemove('')}
          onConfirm={async () => {
            await adminRequest('/admin/availability-windows/' + remove, 'DELETE', {});
            setRemove('');
            reload();
          }}
        >
          <p>Операция отклоняется, если существующий приём останется вне работы.</p>
        </Confirm>
      )}
    </>
  );
}
