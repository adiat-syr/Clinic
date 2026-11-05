import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import type { Service, Doctor } from './api/clinic';
export function render(path: string, data: { services: Service[]; doctors: Doctor[] }) {
  const client = new QueryClient();
  if (data.services.length) client.setQueryData(['services'], data.services);
  if (data.doctors.length) client.setQueryData(['doctors'], data.doctors);
  return renderToString(
    <QueryClientProvider client={client}>
      <App path={path} />
    </QueryClientProvider>,
  );
}
