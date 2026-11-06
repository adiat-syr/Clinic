import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/plus-jakarta-sans';
import { z } from 'zod/mini';
import { serviceSchema, doctorSchema, clinicProfileSchema, clinicProfile } from './api/clinic';
import { App } from './app/App';
import { StaffEntry } from './app/StaffEntry';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, refetchOnWindowFocus: false } },
});
document.documentElement.lang =
  location.pathname.startsWith('/kk') ||
  (location.pathname.startsWith('/admin') &&
    new URLSearchParams(location.search).get('lang') === 'kk')
    ? 'kk'
    : 'ru';
const snapshot = document.getElementById('catalog-data');
if (snapshot?.textContent) {
  try {
    const data = z
      .object({
        services: z.array(serviceSchema),
        doctors: z.array(doctorSchema),
        clinic: z.optional(clinicProfileSchema),
      })
      .parse(JSON.parse(snapshot.textContent));
    if (data.services.length)
      queryClient.setQueryData(['services'], data.services, { updatedAt: 0 });
    if (data.doctors.length) queryClient.setQueryData(['doctors'], data.doctors, { updatedAt: 0 });
    if (data.clinic) queryClient.setQueryData(['clinic'], data.clinic, { updatedAt: 0 });
  } catch {
    /* invalid snapshots never replace API validation */
  }
}

try {
  const profile = await queryClient.fetchQuery({
    queryKey: ['clinic'],
    queryFn: () => clinicProfile(AbortSignal.timeout(10000)),
    retry: false,
  });
  document.documentElement.dataset.clinicTimeZone = profile.timeZone;
} catch {
  /* The page renders a recoverable configuration error; no private values are logged. */
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {location.pathname.startsWith('/admin') ? <StaffEntry /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>,
);
