import { translate as t, adminHref, adminLocale } from './i18n';
import { Component, type ReactNode } from 'react';
import Admin from './Admin';
class AdminBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main className="admin-login" role="alert">
        <h1>{t('Рабочее пространство недоступно')}</h1>
        <p>
          {t(
            'Перезагрузите страницу. Если ошибка сохраняется, сообщите ответственному сотруднику без передачи контактов посетителей.',
          )}
        </p>
        <button onClick={() => location.reload()}>{t('Перезагрузить')}</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export function AdminEntry() {
  return (
    <>
      <nav className="admin-language" aria-label={t('Язык интерфейса')}>
        <a
          href={adminHref(location.pathname, 'ru')}
          lang="ru"
          aria-current={adminLocale() === 'ru' ? 'true' : undefined}
        >
          Русский
        </a>
        <a
          href={adminHref(location.pathname, 'kk')}
          lang="kk"
          aria-current={adminLocale() === 'kk' ? 'true' : undefined}
        >
          Қазақша
        </a>
      </nav>
      <AdminBoundary>
        <Admin />
      </AdminBoundary>
    </>
  );
}
