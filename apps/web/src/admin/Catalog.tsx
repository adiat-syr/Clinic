import { translate as t, labelName, adminLocale } from './i18n';
import { useLoad } from './useLoad';
import { useState, type FormEvent } from 'react';
import { adminRequest, adminDoctor, adminService, pageSchema, message } from './api';
import { LoadState, Pager, Confirm } from './ui';
const doctorFields = [
  ['slug', 'Slug'],
  ['nameRu', t('Имя RU')],
  ['nameKk', t('Имя KK')],
  ['specialtyRu', t('Специальность RU')],
  ['specialtyKk', t('Специальность KK')],
  ['bioRu', t('Описание RU')],
  ['bioKk', t('Описание KK')],
  ['photoAssetKey', t('Локальный ключ фото')],
];
const serviceFields = [
  ['slug', 'Slug'],
  ['nameRu', t('Название RU')],
  ['nameKk', t('Название KK')],
  ['descriptionRu', t('Описание RU')],
  ['descriptionKk', t('Описание KK')],
  ['priceKzt', t('Цена KZT')],
  ['durationMinutes', t('Длительность, минут')],
];
type EditorState = { id?: string; values: Record<string, string>; active: boolean };
export function Catalog({ kind }: { kind: 'doctors' | 'services' }) {
  const [page, setPage] = useState(1),
    [editor, setEditor] = useState<EditorState | null>(null),
    [doctor, setDoctor] = useState('');
  const fields = kind === 'doctors' ? doctorFields : serviceFields;
  const rows = useLoad(
    async (signal) => {
      const response = await adminRequest(
        `/admin/${kind}?page=${page}&pageSize=20`,
        'GET',
        undefined,
        signal,
      );
      return kind === 'doctors'
        ? pageSchema(adminDoctor).parse(response)
        : pageSchema(adminService).parse(response);
    },
    ['catalog', kind, page],
  );
  return (
    <>
      <div className="admin-title">
        <h1>{kind === 'doctors' ? t('Врачи клиники') : t('Услуги и цены')}</h1>
        <button className="button" onClick={() => setEditor({ values: {}, active: true })}>
          {kind === 'doctors' ? t('Добавить врача') : t('Добавить услугу')}
        </button>
      </div>
      <p>
        {t(
          'RU/KK и цены отображаются на клиентском сайте. Публичные SEO-снимки обновляются после сборки.',
        )}
      </p>
      <LoadState {...rows} retry={rows.refresh} />
      <section className="panel">
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Наименование')}</th>
                <th>{t('Состояние')}</th>
                <th>{t('Условия')}</th>
                <th>{t('Действия')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.data?.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    {labelName(row)}
                    <small>{adminLocale() === 'kk' ? row.nameRu : row.nameKk}</small>
                  </td>
                  <td>{row.isActive ? t('Активно') : t('Архив')}</td>
                  <td>
                    {'priceKzt' in row
                      ? `${row.priceKzt} ₸ · ${row.durationMinutes} ${t('мин')}`
                      : 'services' in row
                        ? `${row.services.filter((s) => s.isActive && s.service.isActive).length} ${t('активных услуг')}`
                        : ''}
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        const value: Record<string, unknown> = row;
                        setEditor({
                          id: row.id,
                          active: row.isActive,
                          values: Object.fromEntries(
                            fields.map(([key]) => [key ?? '', String(value[key ?? ''] ?? '')]),
                          ),
                        });
                      }}
                    >
                      {t('Редактировать')}
                    </button>
                    {kind === 'doctors' && (
                      <button onClick={() => setDoctor(row.id)}>{t('Назначить услуги')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.data && <Pager page={page} total={rows.data.pagination.total} setPage={setPage} />}
      </section>
      {editor && (
        <Editor
          key={kind + (editor.id ?? 'new')}
          initial={editor}
          kind={kind}
          close={() => setEditor(null)}
          done={() => {
            setEditor(null);
            rows.refresh();
          }}
        />
      )}
      {doctor && <Assignments id={doctor} close={() => setDoctor('')} done={rows.refresh} />}
    </>
  );
}
function Editor({
  initial,
  kind,
  close,
  done,
}: {
  initial: EditorState;
  kind: 'doctors' | 'services';
  close: () => void;
  done: () => void;
}) {
  const [values, setValues] = useState(initial.values),
    [active, setActive] = useState(initial.active),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const fields = kind === 'doctors' ? doctorFields : serviceFields;
  function body() {
    return kind === 'doctors'
      ? {
          ...(initial.id ? {} : { slug: values.slug }),
          nameRu: values.nameRu ?? '',
          nameKk: values.nameKk ?? '',
          specialtyRu: values.specialtyRu ?? '',
          specialtyKk: values.specialtyKk ?? '',
          bioRu: values.bioRu ?? '',
          bioKk: values.bioKk ?? '',
          photoAssetKey: values.photoAssetKey || null,
          isActive: active,
        }
      : {
          ...(initial.id ? {} : { slug: values.slug }),
          nameRu: values.nameRu ?? '',
          nameKk: values.nameKk ?? '',
          descriptionRu: values.descriptionRu ?? '',
          descriptionKk: values.descriptionKk ?? '',
          priceKzt: values.priceKzt ?? '',
          durationMinutes: Number(values.durationMinutes),
          isActive: active,
        };
  }
  async function save() {
    await adminRequest(
      '/admin/' + kind + (initial.id ? '/' + initial.id : ''),
      initial.id ? 'PATCH' : 'POST',
      body(),
    );
    done();
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (initial.active && !active && initial.id) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError('');
    void save()
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  }
  return (
    <section className="panel admin-editor">
      <h2>{initial.id ? t('Редактирование') : t('Новая запись каталога')}</h2>
      <form onSubmit={submit}>
        {fields
          .filter(([key]) => !initial.id || key !== 'slug')
          .map(([key, label]) => (
            <label key={key}>
              {label}
              {key?.startsWith('bio') || key?.startsWith('description') ? (
                <textarea
                  maxLength={10000}
                  value={values[key] ?? ''}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
              ) : (
                <input
                  required={key !== 'photoAssetKey'}
                  type={key === 'durationMinutes' ? 'number' : 'text'}
                  min={key === 'durationMinutes' ? 1 : undefined}
                  max={key === 'durationMinutes' ? 1440 : undefined}
                  maxLength={key === 'slug' ? 100 : 120}
                  pattern={
                    key === 'slug'
                      ? '[a-z0-9]+(?:-[a-z0-9]+)*'
                      : key === 'priceKzt'
                        ? '(0|[1-9][0-9]{0,9})(\\.[0-9]{1,2})?'
                        : undefined
                  }
                  value={values[key ?? ''] ?? ''}
                  onChange={(e) => setValues({ ...values, [key ?? '']: e.target.value })}
                />
              )}
            </label>
          ))}
        <label className="checkbox">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t('Активно')}
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="admin-actions">
          <button type="button" onClick={close}>
            {t('Закрыть')}
          </button>
          <button className="button" disabled={busy}>
            {t('Сохранить')}
          </button>
        </div>
      </form>
      {confirm && (
        <Confirm
          title={t('Деактивировать запись каталога?')}
          onClose={() => setConfirm(false)}
          onConfirm={save}
        >
          <p>
            {t(
              'Новые заявки будут недоступны. Уже созданные приёмы сохраняются: проверьте будущие записи и при необходимости обработайте их отдельно.',
            )}
          </p>
        </Confirm>
      )}
    </section>
  );
}
function Assignments({ id, close, done }: { id: string; close: () => void; done: () => void }) {
  const [service, setService] = useState(''),
    [active, setActive] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const catalog = useLoad(
    async (signal) => {
      const items = [];
      for (let page = 1; page <= 100; page++) {
        const data = pageSchema(adminService).parse(
          await adminRequest(`/admin/services?page=${page}&pageSize=100`, 'GET', undefined, signal),
        );
        items.push(...data.items);
        if (items.length >= data.pagination.total) return items;
      }
      throw new Error('Too many services');
    },
    ['assignment-services', id],
  );
  async function save() {
    await adminRequest(`/admin/doctors/${id}/services/${service}`, 'PUT', { isActive: active });
    done();
    close();
  }
  return (
    <section className="panel admin-editor">
      <h2>{t('Назначение услуги врачу')}</h2>
      <LoadState {...catalog} retry={catalog.refresh} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!active) {
            setConfirm(true);
            return;
          }
          setBusy(true);
          void save()
            .catch((e) => setError(message(e)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {t('Назначаемая услуга')}
          <select
            aria-label={t('Назначаемая услуга')}
            required
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="">{t('Выберите услугу')}</option>
            {catalog.data?.map((s) => (
              <option value={s.id} key={s.id}>
                {labelName(s)}
                {s.isActive ? '' : t(' (архив)')}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          {t('Назначение активно')}
        </label>
        <p>{t('Деактивация назначения не отменяет существующие приёмы.')}</p>
        {error && <p role="alert">{error}</p>}
        <div className="admin-actions">
          <button type="button" onClick={close}>
            {t('Закрыть')}
          </button>
          <button className="button" disabled={busy}>
            {t('Сохранить назначение')}
          </button>
        </div>
      </form>
      {confirm && (
        <Confirm
          title={t('Деактивировать назначение?')}
          onClose={() => setConfirm(false)}
          onConfirm={save}
        >
          <p>
            {t(
              'Новые заявки по этому назначению будут недоступны. Существующие приёмы сохраняются.',
            )}
          </p>
        </Confirm>
      )}
    </section>
  );
}
