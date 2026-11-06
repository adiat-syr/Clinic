import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import type { Service, Doctor, ClinicProfile } from './api/clinic';
export function render(
  path: string,
  data: { services: Service[]; doctors: Doctor[]; clinic: ClinicProfile },
) {
  const client = new QueryClient();
  client.setQueryData(['clinic'], data.clinic);
  if (data.services.length) client.setQueryData(['services'], data.services);
  if (data.doctors.length) client.setQueryData(['doctors'], data.doctors);
  return renderToString(
    <QueryClientProvider client={client}>
      <App path={path} />
    </QueryClientProvider>,
  );
}
