import { healthResponseSchema } from '@clinic/contracts';

export async function fetchHealth(signal: AbortSignal) {
  const response = await fetch('/api/v1/health/live', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Сервис временно недоступен');
  const body: unknown = await response.json();
  return healthResponseSchema.parse(body);
}
