import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
    const queryClient = new QueryClient();

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
