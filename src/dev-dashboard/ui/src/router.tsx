import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Shell } from "@/routes/__root";
import { ClaudeRoute } from "@/routes/claude";
import { CmuxRoute } from "@/routes/cmux";
import { ContainersRoute } from "@/routes/containers";
import { DaemonRoute } from "@/routes/daemon";
import { IndexRoute } from "@/routes/index";
import { ObsidianRoute } from "@/routes/obsidian";
import { TodosRoute } from "@/routes/todos";
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

const claudeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/claude",
    component: ClaudeRoute,
});

const daemonRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/daemon",
    component: DaemonRoute,
});

const containersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/containers",
    component: ContainersRoute,
});

const todosRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/todos",
    component: TodosRoute,
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    claudeRoute,
    daemonRoute,
    containersRoute,
    todosRoute,
    ttydRoute,
    cmuxRoute,
    obsidianRoute,
]);

export function getRouter() {
    return createRouter({ routeTree, defaultPreload: "intent" });
}
