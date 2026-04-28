import { ErrorBoundary } from "@app/yt/components/shared/error-boundary";
import { Sidebar } from "@app/yt/components/shared/sidebar";
import { Topbar } from "@app/yt/components/shared/topbar";
import { fetchUiConfig } from "@app/yt/config.client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, redirect } from "@tanstack/react-router";

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
    return (
        <div className="cyberpunk flex min-h-screen bg-background/95 text-foreground">
            <div className="pointer-events-none fixed inset-0 cyber-grid opacity-20" />
            <div className="pointer-events-none fixed inset-0 scan-lines opacity-20" />
            <Sidebar />
            <main className="relative z-10 flex min-w-0 flex-1 flex-col">
                <Topbar />
                <div className="flex-1 overflow-auto p-4 lg:p-6">
                    <ErrorBoundary>
                        <Outlet />
                    </ErrorBoundary>
                </div>
            </main>
        </div>
    );
}
