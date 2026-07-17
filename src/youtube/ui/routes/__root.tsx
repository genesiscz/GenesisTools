import { AppShell, AppSidebar, type SidebarNavItem } from "@app/utils/ui/custom";
import { cn } from "@app/utils/ui/lib/utils";
import { ErrorBoundary } from "@app/yt/components/shared/error-boundary";
import { fetchUiConfig } from "@app/yt/config.client";
import { pageTitleFromPath } from "@app/yt/lib/theme";
import { useEventStream } from "@app/yt/ws.client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { BriefcaseBusiness, History, Library, PlaySquare, Settings, Youtube } from "lucide-react";
import type React from "react";

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

function YtSidebarItem({
    item,
    active,
    LinkComponent,
}: {
    item: SidebarNavItem;
    active: boolean;
    LinkComponent: React.ElementType;
}) {
    const Icon = item.icon;

    return (
        <LinkComponent
            to={item.url}
            className={cn(
                "group flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium transition-all duration-200",
                active
                    ? "border-primary/40 bg-primary/15 text-primary shadow-[0_0_24px_rgba(245,158,11,0.12)]"
                    : "border-transparent text-muted-foreground hover:-translate-y-0.5 hover:border-secondary/30 hover:bg-secondary/10 hover:text-secondary"
            )}
        >
            <Icon className="size-4" />
            <span>{item.title}</span>
        </LinkComponent>
    );
}

function RootLayout() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { connected } = useEventStream({ enabled: pathname !== "/first-run" });

    return (
        <AppShell
            themeClass="cyberpunk"
            glowVariant="rich"
            sidebar={
                <AppSidebar
                    renderBrand={() => (
                        <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/10 p-4 neon-border">
                            <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
                                <PlaySquare className="size-5" />
                            </div>
                            <div>
                                <p className="text-xs font-mono uppercase tracking-[0.35em] text-primary">Genesis</p>
                                <h1 className="text-lg font-semibold text-foreground">YouTube AI</h1>
                            </div>
                        </div>
                    )}
                    navGroups={[
                        {
                            label: "",
                            theme: "primary",
                            items: [
                                { title: "Channels", url: "/", icon: Youtube },
                                { title: "History", url: "/history", icon: History },
                                { title: "Collections", url: "/collections", icon: Library },
                                { title: "Jobs", url: "/jobs", icon: BriefcaseBusiness },
                                { title: "Settings", url: "/settings", icon: Settings },
                            ],
                        },
                    ]}
                    activePath={pathname}
                    MenuItemComponent={YtSidebarItem}
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
