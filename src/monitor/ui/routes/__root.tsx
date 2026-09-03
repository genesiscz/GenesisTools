import { useLiveUpdates, useOverview } from "@app/monitor/ui/api.hooks";
import { WatcherDialog } from "@app/monitor/ui/components/watcher-dialog";
import { Button } from "@genesiscz/utils/ui/components/button";
import { AppShell, AppSidebar, type SidebarNavItem } from "@genesiscz/utils/ui/custom";
import { cn } from "@genesiscz/utils/ui/lib/utils";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, Bell, Plus, Radar, Siren } from "lucide-react";
import type React from "react";
import { useState } from "react";

interface RouterContext {
    queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootLayout,
});

const TITLES: Array<[RegExp, string]> = [
    [/^\/watchers\//, "Watcher"],
    [/^\/incidents/, "Incidents"],
    [/^\/settings/, "Notifications"],
    [/^\/$/, "Overview"],
];

function pageTitle(pathname: string): string {
    return TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? "Monitor";
}

function MonSidebarItem({
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

function SidebarSummary() {
    const overview = useOverview();
    const counts = overview.data?.counts;

    if (!counts) {
        return null;
    }

    const open = overview.data?.openIncidents.length ?? 0;

    return (
        <div className="space-y-2 rounded-2xl border border-border/50 bg-card/40 p-3 font-mono text-[0.68rem] uppercase tracking-[0.18em]">
            <div className="flex justify-between text-muted-foreground">
                <span>Up</span>
                <span className="text-emerald-300">{counts.up}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
                <span>Degraded</span>
                <span className="text-amber-200">{counts.degraded}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
                <span>Down</span>
                <span className="text-red-300">{counts.down}</span>
            </div>
            <div className="flex justify-between border-t border-border/40 pt-2 text-muted-foreground">
                <span>Open incidents</span>
                <span className={open > 0 ? "text-amber-200" : "text-foreground"}>{open}</span>
            </div>
        </div>
    );
}

function RootLayout() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { connected } = useLiveUpdates();
    const [adding, setAdding] = useState(false);

    return (
        <AppShell
            themeClass="cyberpunk"
            glowVariant="rich"
            sidebar={
                <AppSidebar
                    renderBrand={() => (
                        <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/10 p-4 neon-border">
                            <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25">
                                <Radar className="size-5" />
                            </div>
                            <div>
                                <p className="font-mono text-xs uppercase tracking-[0.35em] text-primary">Genesis</p>
                                <h1 className="text-lg font-semibold text-foreground">Monitor</h1>
                            </div>
                        </div>
                    )}
                    navGroups={[
                        {
                            label: "",
                            theme: "primary",
                            items: [
                                { title: "Overview", url: "/", icon: Activity },
                                { title: "Incidents", url: "/incidents", icon: Siren },
                                { title: "Notifications", url: "/settings", icon: Bell },
                            ],
                        },
                    ]}
                    activePath={pathname}
                    MenuItemComponent={MonSidebarItem}
                    LinkComponent={Link}
                    renderFooter={() => <SidebarSummary />}
                />
            }
            title={pageTitle(pathname)}
            statusLabel={connected ? "Live" : "Polling"}
            headerEnd={
                <Button size="sm" className="btn-glow" onClick={() => setAdding(true)}>
                    <Plus className="size-4" /> Add watcher
                </Button>
            }
            gridBackground
            scanLinesEffect
        >
            <Outlet />
            <WatcherDialog open={adding} onOpenChange={setAdding} />
        </AppShell>
    );
}
