import { translate as t } from './i18n';
import { useState, useRef, useEffect, type ReactNode } from 'react';
import { message } from './api';
export function LoadState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  return loading ? (
    <p role="status">{t('Загружаем…')}</p>
  ) : error ? (
    <div role="alert" className="error">
      <p>{message(error)}</p>
      <button type="button" onClick={retry}>
        {t('Повторить')}
      </button>
    </div>
  ) : null;
}
export function Pager({
  page,
  total,
  setPage,
}: {
  page: number;
  total: number;
  setPage: (n: number) => void;
}) {
  return (
    <div className="admin-pager">
      <span>
        {t('Всего: ')}
        {total}
        {t(' · Страница ')}
        {page}
      </span>
      <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
        {t('Назад')}
      </button>
      <button disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>
        {t('Далее')}
      </button>
    </div>
  );
}
export function Confirm({
  title,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className="panel admin-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <section>
        <h2>{title}</h2>
        {children}
        {!!error && <p role="alert">{message(error)}</p>}
        <div className="admin-actions">
          <button disabled={busy} onClick={onClose}>
            {t('Назад')}
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onConfirm()
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? t('Выполняем…') : t('Подтвердить')}
          </button>
        </div>
      </section>
    </dialog>
  );
}
