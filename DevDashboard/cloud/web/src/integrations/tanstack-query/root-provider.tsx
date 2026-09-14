import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

export function getContext() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 10_000,
                retry: 1,
            },
        },
    });

    return { queryClient };
}

export function Provider({ children, queryClient }: { children: ReactNode; queryClient: QueryClient }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
