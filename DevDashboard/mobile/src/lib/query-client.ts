import { QueryClient } from "@tanstack/react-query";

/** A server-state cache owned by one connection session. Never share it across machines. */
export function createConnectionQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: { queries: { retry: 2, staleTime: 5_000 } },
    });
}
