import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

export function getContext() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 10_000,
                retry: 1,
            },
            mutations: {
                // Floor so no mutation fails silently. Per-mutation onError
                // still overrides this with a specific message where defined.
                onError: (err: unknown) => {
                    toast.error(err instanceof Error ? err.message : "Action failed — please retry.");
                },
            },
        },
    });
    return { queryClient };
}

export function Provider({ children, queryClient }: { children: React.ReactNode; queryClient: QueryClient }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
