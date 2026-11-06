import { translate as t } from './i18n';
import { useLoad } from './useLoad';
import { useState } from 'react';
import { adminRequest, auditSchema, pageSchema, clinicDay, range, time } from './api';
import { LoadState, Pager } from './ui';
export function Audit() {
  const [date, setDate] = useState(clinicDay),
    [page, setPage] = useState(1);
  const rows = useLoad(
    (signal) =>
      adminRequest(
        '/admin/audit-events?' +
          new URLSearchParams({ ...range(date), page: String(page), pageSize: '20' }),
        'GET',
        undefined,
        signal,
      ).then((v) => pageSchema(auditSchema).parse(v)),
    ['audit', date, page],
  );
  return (
    <>
      <h1>{t('Аудит действий')}</h1>
      <p>
        {t(
          'Технические события без контактов, паролей и значений полей. Чтение журнала тоже аудируется.',
        )}
      </p>
      <label>
        {t('Дата аудита')}
        <input
          type="date"
          required
          value={date}
          onChange={(e) => {
            if (e.target.value) setDate(e.target.value);
            setPage(1);
          }}
        />
      </label>
      <LoadState {...rows} retry={rows.refresh} />
      <section className="panel">
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Время')}</th>
                <th>{t('Действие')}</th>
                <th>{t('Объект')}</th>
                <th>{t('Сотрудник')}</th>
                <th>{t('Поля / requestId')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.data?.items.map((r) => (
                <tr key={r.id}>
                  <td>{time(r.createdAt)}</td>
                  <td>{r.action}</td>
                  <td>
                    {r.entityType}
                    <small>{r.entityId}</small>
                  </td>
                  <td className="admin-reference">{r.actorUserId ?? t('Система')}</td>
                  <td>
                    {r.metadata.fields?.join(', ')}
                    <small className="admin-reference">{r.requestId}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.data && <Pager page={page} total={rows.data.pagination.total} setPage={setPage} />}
      </section>
    </>
  );
}
