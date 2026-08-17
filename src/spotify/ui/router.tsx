import { routeTree } from "@app/spotify/ui/routeTree.gen";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

export function getRouter() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                // Reports are derived from files on disk that only change when a new export
                // lands, so a long stale time keeps tab switches instant.
                staleTime: 5 * 60_000,
                retry: 1,
                refetchOnWindowFocus: false,
            },
        },
    });

    const router = createRouter({
        routeTree,
        defaultPreload: "intent",
        Wrap: (props: { children: React.ReactNode }) => {
            return <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>;
        },
    });

    return router;
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
