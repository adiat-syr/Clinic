import { lazy, Suspense } from 'react';

const Admin = lazy(() =>
  import('../admin/Entry').then((module) => ({ default: module.AdminEntry })),
);

// Keep the tiny bootstrap fallback outside the lazy staff dictionary/bundle.
export function StaffEntry() {
  return (
    <Suspense
      fallback={
        <p role="status">{document.documentElement.lang === 'kk' ? 'Жүктелуде…' : 'Загружаем…'}</p>
      }
    >
      <Admin />
    </Suspense>
  );
}
