import { lazy, Suspense, Component, type ReactNode } from 'react';
const Admin = lazy(() => import('./Admin'));
class AdminBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main className="admin-login" role="alert">
        <h1>Рабочее пространство недоступно</h1>
        <p>
          Перезагрузите страницу. Если ошибка сохраняется, сообщите ответственному сотруднику без
          передачи контактов посетителей.
        </p>
        <button onClick={() => location.reload()}>Перезагрузить</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
export function AdminEntry() {
  return (
    <AdminBoundary>
      <Suspense fallback={<p role="status">Загружаем рабочее пространство…</p>}>
        <Admin />
      </Suspense>
    </AdminBoundary>
  );
}
