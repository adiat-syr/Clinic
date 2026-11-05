import { useLoad } from './useLoad';
import { useState } from 'react';
import { doctors, services, availabilitySchema, request } from '../api/clinic';
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
    [search, setSearch] = useState('');
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
          <h1>Записи на приём</h1>
          <p>Заявки, подтверждение и работа с расписанием</p>
        </div>
        <button
          onClick={() => {
            rows.refresh();
            setSelected('');
          }}
        >
          Обновить
        </button>
      </div>
      <div className="admin-metrics">
        <div className="panel">
          <span>Найдено записей</span>
          <strong>{rows.data?.pagination.total ?? '—'}</strong>
        </div>
        <div className="panel">
          <span>Фильтр статуса</span>
          <strong>{status ? statuses[status as keyof typeof statuses] : 'Все статусы'}</strong>
        </div>
      </div>
      <section className="panel admin-filters">
        <label>
          Дата
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
          Врач
          <select
            value={doctor}
            onChange={(e) => {
              setDoctor(e.target.value);
              reset();
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
          Статус
          <select
            aria-label="Статус"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              reset();
            }}
          >
            <option value="">Все статусы</option>
            {Object.entries(statuses).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Номер на текущей странице
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
          <h2>Список приёмов</h2>
          {rows.data && !rows.data.items.length && <p>На выбранную дату записей нет.</p>}
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Номер / статус</th>
                  <th>Врач и услуга</th>
                  <th>Цена</th>
                  <th>Действие</th>
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
                        {r.doctorNameRu ??
                          team.data?.find((d) => d.id === r.doctorId)?.nameRu ??
                          r.doctorId}
                        <small>
                          {r.serviceNameRu ??
                            catalog.data?.find((s) => s.id === r.serviceId)?.nameRu ??
                            r.serviceId}
                        </small>
                      </td>
                      <td>{r.priceKzt} ₸</td>
                      <td>
                        <button
                          aria-label={'Открыть ' + r.reference}
                          onClick={() => setSelected(r.id)}
                        >
                          Карточка
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
      <button onClick={close}>Закрыть карточку</button>
      <LoadState {...detail} retry={detail.refresh} />
      {row && (
        <>
          <h2>Карточка заявки</h2>
          <p className="admin-reference">{row.reference}</p>
          <span className={'status status-' + row.status}>{statuses[row.status]}</span>
          <h3>{row.contacts?.name ?? 'Контакты удалены'}</h3>
          <p>{row.contacts?.phone}</p>
          <p>
            {row.doctorNameRu}
            <br />
            {row.serviceNameRu}
          </p>
          <p>
            {time(row.startsAt)} — {time(row.endsAt)}
            <br />
            {row.priceKzt} ₸ · {row.durationMinutes} мин
          </p>
          <p>Версия: {row.version}. Чтение контактов записано в аудит.</p>
          <div className="admin-actions vertical">
            {row.status === 'PENDING' && new Date(row.startsAt).getTime() > now && (
              <button className="button" onClick={() => setOperation('CONFIRMED')}>
                Подтвердить запись
              </button>
            )}
            {['PENDING', 'CONFIRMED'].includes(row.status) && (
              <>
                <button onClick={() => setOperation('reschedule')}>Перенести время</button>
                <button className="danger" onClick={() => setOperation('CANCELLED')}>
                  Отменить запись
                </button>
              </>
            )}
            {row.status === 'CONFIRMED' && new Date(row.endsAt).getTime() <= now && (
              <>
                <button onClick={() => setOperation('COMPLETED')}>Завершить приём</button>
                <button onClick={() => setOperation('NO_SHOW')}>Отметить неявку</button>
              </>
            )}
            {admin && !row.consent?.withdrawnAt && (
              <button
                onClick={() => {
                  setVerified(false);
                  setOperation('withdraw');
                }}
              >
                Зафиксировать отзыв согласия
              </button>
            )}
            <button onClick={detail.refresh}>Обновить карточку</button>
          </div>
          {row.consent?.withdrawnAt && <p>Отзыв согласия: {time(row.consent.withdrawnAt)}</p>}
          {operation === 'reschedule' ? (
            <Reschedule row={row} done={success} close={() => setOperation('')} />
          ) : (
            operation && (
              <Confirm
                title={
                  operation === 'withdraw'
                    ? 'Проверенный отзыв согласия'
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
                <p>Проверьте номер и время заявки. Изменения фиксируются в аудите.</p>
                {operation === 'withdraw' && (
                  <>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={verified}
                        onChange={(e) => setVerified(e.target.checked)}
                      />
                      Личность и обращение проверены
                    </label>
                    <p>
                      Фиксация не удаляет и не отменяет запись автоматически. Дальнейшие действия —
                      по утверждённому регламенту.
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
  row: { id: string; doctorId: string; serviceId: string; version: number };
  done: () => void;
  close: () => void;
}) {
  const team = useLoad((signal) => doctors(signal), ['move-doctors']),
    [doctor, setDoctor] = useState(row.doctorId),
    [service, setService] = useState(row.serviceId),
    [date, setDate] = useState(clinicDay),
    [slot, setSlot] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
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
      <h3>Перенос записи</h3>
      <p>При конфликте исходный приём сохранится.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!slots.data?.slots.some((s) => s.startsAt === slot)) {
            setError('Выберите доступное время.');
            return;
          }
          setBusy(true);
          void adminRequest('/admin/appointments/' + row.id, 'PATCH', {
            action: 'reschedule',
            version: row.version,
            doctorId: doctor,
            serviceId: service,
            startsAt: slot,
            expectedPriceKzt: slots.data.priceKzt,
            expectedDurationMinutes: slots.data.durationMinutes,
          })
            .then(done)
            .catch((e) => {
              setError(message(e));
              setSlot('');
              slots.refresh();
            })
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Врач для переноса
          <select
            aria-label="Врач для переноса"
            value={doctor}
            onChange={(e) => {
              setDoctor(e.target.value);
              setService('');
              setSlot('');
            }}
          >
            {team.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nameRu}
              </option>
            ))}
          </select>
        </label>
        <label>
          Услуга для переноса
          <select
            aria-label="Услуга для переноса"
            required
            value={service}
            onChange={(e) => {
              setService(e.target.value);
              setSlot('');
            }}
          >
            <option value="">Выберите услугу</option>
            {selected?.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nameRu}
              </option>
            ))}
          </select>
        </label>
        <label>
          Новая дата
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
        {slots.data && !slots.data.slots.length && <p>Нет свободного времени.</p>}
        {slots.data && (
          <p>
            Новые условия: {slots.data.priceKzt} ₸ · {slots.data.durationMinutes} мин
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="admin-actions">
          <button type="button" onClick={close}>
            Назад
          </button>
          <button className="button" disabled={busy}>
            Сохранить перенос
          </button>
        </div>
      </form>
    </section>
  );
}
