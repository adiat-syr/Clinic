import { useQuery } from '@tanstack/react-query';
export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: unknown[]) {
  const query = useQuery({
    queryKey: ['admin', ...dependencies],
    queryFn: ({ signal }) => loader(signal),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  return {
    data: query.data ?? null,
    error: query.error,
    loading: query.isPending,
    refresh: () => {
      void query.refetch();
    },
  };
}
