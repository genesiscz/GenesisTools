import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Creates a new QueryClient and returns it inside a context object.
 *
 * @returns An object containing the newly created `queryClient`.
 */
export function getContext() {
  const queryClient = new QueryClient()
  return {
    queryClient,
  }
}

/**
 * Provides a TanStack Query client to descendant React components.
 *
 * @param children - The React node(s) to render inside the provider.
 * @param queryClient - The QueryClient instance to supply to descendants.
 * @returns A JSX element that supplies the given `queryClient` to its descendants.
 */
export function Provider({
  children,
  queryClient,
}: {
  children: React.ReactNode
  queryClient: QueryClient
}) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}