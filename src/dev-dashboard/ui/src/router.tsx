import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createRootRoute,
    createRoute,
    createRouter,
    lazyRouteComponent,
    Outlet,
    redirect,
} from "@tanstack/react-router";
import { parseObsidianSearch } from "@/lib/obsidian-url-state";
import { Shell } from "@/routes/__root";

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

// Every page is its own chunk, so opening the terminal page on a phone does not download
// highlight.js, KaTeX and recharts, which only the QA, handoff and chart pages use. Hover
// and touch preload a page's chunk through `defaultPreload: "intent"`.
const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: lazyRouteComponent(() => import("@/routes/index"), "IndexRoute"),
});

const ttydRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/ttyd",
    validateSearch: (search: Record<string, unknown>): { tab?: string } => {
        const tab = search.tab;

        if (typeof tab === "string" && tab.length > 0) {
            return { tab };
        }

        return {};
    },
    component: lazyRouteComponent(() => import("@/routes/ttyd"), "TtydRoute"),
});

const cmuxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/cmux",
    component: lazyRouteComponent(() => import("@/routes/cmux"), "CmuxRoute"),
});

const obsidianRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/obsidian",
    validateSearch: (search: Record<string, unknown>) => parseObsidianSearch(search),
    component: lazyRouteComponent(() => import("@/routes/obsidian"), "ObsidianRoute"),
});

const aiAccountsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/ai/accounts",
    component: lazyRouteComponent(() => import("@/routes/ai-accounts"), "AiAccountsRoute"),
});

// The Claude-only usage page became the multi-provider /ai/accounts page. The old
// path stays as a redirect so bookmarks and pinned tabs keep working.
const claudeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/claude",
    beforeLoad: () => {
        throw redirect({ to: "/ai/accounts" });
    },
});

const daemonRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/daemon",
    component: lazyRouteComponent(() => import("@/routes/daemon"), "DaemonRoute"),
});

const buildLogTailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/build-log-tail",
    component: lazyRouteComponent(() => import("@/routes/build-log-tail"), "BuildLogTailRoute"),
});

const activityTimelineRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/activity-timeline",
    component: lazyRouteComponent(() => import("@/routes/activity-timeline"), "ActivityTimelineRoute"),
});

const containersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/containers",
    component: lazyRouteComponent(() => import("@/routes/containers"), "ContainersRoute"),
});

const diskJanitorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/disk-janitor",
    component: lazyRouteComponent(() => import("@/routes/disk-janitor"), "DiskJanitorRoute"),
});

const portKillerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/port-killer",
    component: lazyRouteComponent(() => import("@/routes/port-killer"), "PortKillerRoute"),
});

const processMonitorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/process-monitor",
    component: lazyRouteComponent(() => import("@/routes/process-monitor"), "ProcessMonitorRoute"),
});

const todosRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/todos",
    component: lazyRouteComponent(() => import("@/routes/todos"), "TodosRoute"),
});

const qaRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/qa",
    component: lazyRouteComponent(() => import("@/routes/qa"), "QaRoute"),
});

const needsInputInboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/needs-input-inbox",
    component: lazyRouteComponent(() => import("@/routes/needs-input-inbox"), "NeedsInputInboxRoute"),
});

const networkStatusRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/network-status",
    component: lazyRouteComponent(() => import("@/routes/network-status"), "NetworkStatusRoute"),
});

const tmuxPresetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tmux-presets",
    component: lazyRouteComponent(() => import("@/routes/tmux-presets"), "TmuxPresetsRoute"),
});

const quickCommandsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/quick-commands",
    component: lazyRouteComponent(() => import("@/routes/quick-commands"), "QuickCommandsRoute"),
});

const boardsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/boards",
    component: lazyRouteComponent(() => import("@/routes/boards"), "BoardsRoute"),
});

const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/boards/$slug",
    component: lazyRouteComponent(() => import("@/routes/board"), "BoardRoute"),
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    aiAccountsRoute,
    claudeRoute,
    daemonRoute,
    buildLogTailRoute,
    activityTimelineRoute,
    containersRoute,
    diskJanitorRoute,
    portKillerRoute,
    processMonitorRoute,
    todosRoute,
    qaRoute,
    needsInputInboxRoute,
    networkStatusRoute,
    tmuxPresetsRoute,
    quickCommandsRoute,
    ttydRoute,
    cmuxRoute,
    obsidianRoute,
    boardsRoute,
    boardRoute,
]);

export function getRouter() {
    return createRouter({ routeTree, defaultPreload: "intent" });
}
