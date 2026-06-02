import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { parseObsidianSearch } from "@/lib/obsidian-url-state";
import { Shell } from "@/routes/__root";
import { ActivityTimelineRoute } from "@/routes/activity-timeline";
import { BuildLogTailRoute } from "@/routes/build-log-tail";
import { ClaudeRoute } from "@/routes/claude";
import { CmuxRoute } from "@/routes/cmux";
import { ContainersRoute } from "@/routes/containers";
import { DaemonRoute } from "@/routes/daemon";
import { DiskJanitorRoute } from "@/routes/disk-janitor";
import { IndexRoute } from "@/routes/index";
import { NeedsInputInboxRoute } from "@/routes/needs-input-inbox";
import { NetworkStatusRoute } from "@/routes/network-status";
import { ObsidianRoute } from "@/routes/obsidian";
import { PortKillerRoute } from "@/routes/port-killer";
import { ProcessMonitorRoute } from "@/routes/process-monitor";
import { QaRoute } from "@/routes/qa";
import { QuickCommandsRoute } from "@/routes/quick-commands";
import { TmuxPresetsRoute } from "@/routes/tmux-presets";
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
    validateSearch: (search: Record<string, unknown>): { tab?: string } => {
        const tab = search.tab;

        if (typeof tab === "string" && tab.length > 0) {
            return { tab };
        }

        return {};
    },
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
    validateSearch: (search: Record<string, unknown>) => parseObsidianSearch(search),
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

const buildLogTailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/build-log-tail",
    component: BuildLogTailRoute,
});

const activityTimelineRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/activity-timeline",
    component: ActivityTimelineRoute,
});

const containersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/containers",
    component: ContainersRoute,
});

const diskJanitorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/disk-janitor",
    component: DiskJanitorRoute,
});

const portKillerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/port-killer",
    component: PortKillerRoute,
});

const processMonitorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/process-monitor",
    component: ProcessMonitorRoute,
});

const todosRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/todos",
    component: TodosRoute,
});

const qaRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/qa",
    component: QaRoute,
});

const needsInputInboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/needs-input-inbox",
    component: NeedsInputInboxRoute,
});

const networkStatusRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/network-status",
    component: NetworkStatusRoute,
});

const tmuxPresetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/tmux-presets",
    component: TmuxPresetsRoute,
});

const quickCommandsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/quick-commands",
    component: QuickCommandsRoute,
});

const routeTree = rootRoute.addChildren([
    indexRoute,
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
]);

export function getRouter() {
    return createRouter({ routeTree, defaultPreload: "intent" });
}
