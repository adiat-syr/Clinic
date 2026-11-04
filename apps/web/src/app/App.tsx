import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '../api/health';
import styles from './App.module.css';

export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: false,
    staleTime: 30_000,
  });

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brandMark} aria-hidden="true">
          +
        </div>
        <span className={styles.brand}>
          ALATAU <span>Clinic</span>
        </span>
        <span className={styles.environment}>Среда разработки</span>
      </header>
      <main className={styles.main}>
        <div className={styles.card}>
          <p className={styles.label}>Сайт готовится к запуску</p>
          <h1>Пространство заботы начинается здесь</h1>
          <p className={styles.description}>
            Онлайн-запись пока недоступна. Эта версия предназначена для проверки технической основы
            сайта и не принимает персональные данные.
          </p>
          <div className={styles.status} role="status" aria-live="polite">
            <span className={styles.dot} aria-hidden="true" />
            {health.isPending
              ? 'Проверяем соединение…'
              : health.isError
                ? 'Нет соединения с сервером'
                : 'Соединение с сервером установлено'}
          </div>
          {health.isError ? (
            <button className={styles.button} type="button" onClick={() => void health.refetch()}>
              Проверить ещё раз
            </button>
          ) : null}
          <p className={styles.note}>
            Только синтетические данные. Формы записи ещё не подключены.
          </p>
        </div>
      </main>
    </div>
  );
}
