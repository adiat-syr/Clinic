import { useQuery } from '@tanstack/react-query';
import { clinicProfile } from '../api/clinic';
import { lazy, Suspense } from 'react';

const Admin = lazy(() =>
  import('../admin/Entry').then((module) => ({ default: module.AdminEntry })),
);

// Keep the tiny bootstrap fallback outside the lazy staff dictionary/bundle.
export function StaffEntry() {
  const profile = useQuery({
    queryKey: ['clinic'],
    queryFn: ({ signal }) => clinicProfile(signal),
    retry: false,
    enabled: false,
  });
  if (!profile.data)
    return (
      <main className="container">
        <p role={profile.isError ? 'alert' : 'status'}>
          {document.documentElement.lang === 'kk'
            ? profile.isError
              ? 'Қате орын алды'
              : 'Жүктелуде…'
            : profile.isError
              ? 'Не удалось загрузить настройки'
              : 'Загружаем…'}
        </p>
        {profile.isError && (
          <button onClick={() => location.reload()}>
            {document.documentElement.lang === 'kk' ? 'Қайталау' : 'Повторить'}
          </button>
        )}
      </main>
    );
  return (
    <Suspense
      fallback={
        <p role="status">{document.documentElement.lang === 'kk' ? 'Жүктелуде…' : 'Загружаем…'}</p>
      }
    >
      <Admin clinic={profile.data} />
    </Suspense>
  );
}
