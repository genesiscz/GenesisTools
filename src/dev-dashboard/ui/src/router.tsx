import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Shell } from "@/routes/__root";
import { CmuxRoute } from "@/routes/cmux";
import { IndexRoute } from "@/routes/index";
import { ObsidianRoute } from "@/routes/obsidian";
import { TtydRoute } from "@/routes/ttyd";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 1000,
            refetchOnWindowFocus: false,
        },
    },
});

const rootRoute = createRootRoute({
    component: () => (
        <QueryClientProvider client={queryClient}>
            <Shell>
                <Outlet />
            </Shell>
        </QueryClientProvider>
    ),
});

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: IndexRoute,
});

const ttydRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/ttyd",
    component: TtydRoute,
});

const cmuxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/cmux",
    component: CmuxRoute,
});

const obsidianRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/obsidian",
    component: ObsidianRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, ttydRoute, cmuxRoute, obsidianRoute]);

export function getRouter() {
    return createRouter({ routeTree, defaultPreload: "intent" });
}
