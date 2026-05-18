import { AppShell, AppSidebar } from "@app/utils/ui/custom";
import { ErrorBoundary } from "@app/yt/components/shared/error-boundary";
import { fetchUiConfig } from "@app/yt/config.client";
import { pageTitleFromPath } from "@app/yt/lib/theme";
import { useEventStream } from "@app/yt/ws.client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { BriefcaseBusiness, Settings, Youtube } from "lucide-react";

interface RouterContext {
    queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    beforeLoad: async ({ location }) => {
        if (location.pathname === "/first-run") {
            return;
        }

        const { config } = await fetchUiConfig();

        if (!config.firstRunComplete) {
            throw redirect({ to: "/first-run" });
        }
    },
    component: RootLayout,
});

function RootLayout() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { connected } = useEventStream({ enabled: pathname !== "/first-run" });

    return (
        <AppShell
            sidebar={
                <AppSidebar
                    brand={{ initial: "Y", name: "YouTube AI", tagline: "Genesis", to: "/" }}
                    navGroups={[
                        {
                            label: "Pipeline",
                            theme: "primary",
                            items: [
                                { title: "Channels", url: "/", icon: Youtube },
                                { title: "Jobs", url: "/jobs", icon: BriefcaseBusiness },
                                { title: "Settings", url: "/settings", icon: Settings },
                            ],
                        },
                    ]}
                    activePath={pathname}
                    LinkComponent={Link}
                />
            }
            title={pageTitleFromPath(pathname)}
            statusLabel={connected ? "Live" : "Polling"}
            gridBackground
            scanLinesEffect
        >
            <ErrorBoundary>
                <Outlet />
            </ErrorBoundary>
        </AppShell>
    );
}
