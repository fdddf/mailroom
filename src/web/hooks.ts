import { notifications } from '@mantine/notifications'
import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { ApiError, api, call, errorText } from './api'

// An expired session anywhere sends the whole app back to the login screen,
// by refetching the session query (whose 401 shows the login form). The
// session query's own 401 must not trigger this, or it would loop.
const onError = (err: unknown, key?: QueryKey) => {
  if (err instanceof ApiError && err.status === 401 && key?.[0] !== 'session') {
    queryClient.invalidateQueries({ queryKey: ['session'] })
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => onError(err, query.queryKey) }),
  mutationCache: new MutationCache({
    // A mutation with meta.quiet shows its own error.
    onError: (err, _vars, _context, mutation) => {
      onError(err)
      if (!(err instanceof ApiError && err.status === 401) && !mutation.meta?.quiet) {
        notifications.show({ color: 'red', title: 'Something went wrong', message: errorText(err) })
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
  },
})

export const useSession = () =>
  useQuery({ queryKey: ['session'], queryFn: () => call(api.session.$get()), retry: false, refetchInterval: 60_000 })

export type Session = NonNullable<ReturnType<typeof useSession>['data']>

// A mutation that refreshes the given queries (and the nav badges) when it
// succeeds, and optionally toasts a message.
export const useAction = <TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  { invalidate = [], success }: { invalidate?: QueryKey[]; success?: string | ((r: TResult) => string) } = {},
) => {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      await Promise.all([...invalidate, ['session']].map((queryKey) => client.invalidateQueries({ queryKey })))
      const message = typeof success === 'function' ? success(result) : success
      if (message) notifications.show({ color: 'teal', message })
    },
  })
}

export const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const fmtFull = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })

// The domain the dashboard is looking at (null: all of them), as the server
// understood it, and the mailboxes that can send for it.
export const useScope = () => {
  const { data: session } = useSession()
  const domainId = session?.domainId ?? null
  const domain = session?.domains.find((d) => d.id === domainId) ?? null
  const mailboxes = (session?.mailboxes ?? []).filter((m) => !domainId || m.domainId === domainId)
  return { session, domain, domainId, mailboxes }
}

// "example.com", for a domain id from a list row.
export const useDomainName = () => {
  const { data: session } = useSession()
  return (id: number | null | undefined) => session?.domains.find((d) => d.id === id)?.name ?? ''
}
