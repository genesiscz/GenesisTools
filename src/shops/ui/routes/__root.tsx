import appCss from "@app/shops/ui/styles.css?url";
import { Badge } from "@app/utils/ui/components/badge";
import { DashboardLayout } from "@app/utils/ui/layouts/DashboardLayout";
import { useQuery } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts, useRouter, useRouterState } from "@tanstack/react-router";
import { Bell, GitMerge, Heart, LayoutGrid, LayoutTemplate, Plug, Radio, Settings, ShoppingBasket } from "lucide-react";
import { Toaster } from "sonner";

const navLinks = [
    { label: "Watchlist", href: "/watchlist", icon: <Heart className="w-3.5 h-3.5" /> },
    { label: "Providers", href: "/providers", icon: <Plug className="w-3.5 h-3.5" /> },
    { label: "Browse", href: "/browse", icon: <LayoutGrid className="w-3.5 h-3.5" /> },
    { label: "Live", href: "/live", icon: <Radio className="w-3.5 h-3.5" /> },
    { label: "Workspace", href: "/workspace", icon: <LayoutTemplate className="w-3.5 h-3.5" /> },
    { label: "Coverage", href: "/coverage", icon: <ShoppingBasket className="w-3.5 h-3.5" /> },
    { label: "Match", href: "/match/review", icon: <GitMerge className="w-3.5 h-3.5" /> },
    { label: "Alerts", href: "/notifications", icon: <Bell className="w-3.5 h-3.5" /> },
    { label: "Settings", href: "/settings", icon: <Settings className="w-3.5 h-3.5" /> },
];

export const Route = createRootRoute({
    notFoundComponent: () => (
        <div className="p-12 text-center text-muted-foreground font-mono">
            <div className="text-2xl text-[var(--color-neon-coral)] tracking-[0.3em] mb-2">404 :: VOID</div>
            <div className="text-sm">no route bound to this path</div>
        </div>
    ),
    head: () => ({
        title: "GenesisTools - Shops",
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { name: "theme-color", content: "#0d0d14" },
            { name: "description", content: "Czech eshop price aggregator — watchlist, alerts, observability" },
        ],
        links: [{ rel: "stylesheet", href: appCss }],
    }),
    shellComponent: RootDocument,
    component: RootComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className="cyberpunk">
            <head>
                <HeadContent />
            </head>
            <body>
                {children}
                <Scripts />
            </body>
        </html>
    );
}

function RootComponent() {
    return (
        <ShopsLayout>
            <Outlet />
            <Toaster
                theme="dark"
                toastOptions={{
                    style: {
                        background: "#121219",
                        border: "1px solid rgba(34, 211, 238, 0.25)",
                        color: "#ededed",
                        fontFamily: "monospace",
                    },
                }}
            />
        </ShopsLayout>
    );
}

function ShopsLayout({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const location = useRouterState({ select: (s) => s.location });
    const segments = location.pathname.split("/").filter(Boolean);
    const currentPath = segments.length > 0 ? `/${segments.slice(0, 2).join("/")}` : "/";
    const matchBadgeCount = useMatchPendingCount();

    const decoratedLinks = navLinks.map((l) => {
        if (l.href !== "/match/review" || matchBadgeCount <= 0) {
            return l;
        }

        return {
            ...l,
            badge: (
                <Badge
                    variant="destructive"
                    className="ml-1 h-4 min-w-4 px-1 text-[9px] font-mono leading-none rounded-full"
                >
                    {matchBadgeCount}
                </Badge>
            ),
        };
    });

    return (
        <DashboardLayout
            title="SHOPS"
            titleAccent="CZ"
            navLinks={decoratedLinks}
            activePath={currentPath}
            onNavigate={(href: string) => router.navigate({ to: href })}
        >
            {children}
        </DashboardLayout>
    );
}

function useMatchPendingCount(): number {
    const q = useQuery({
        queryKey: ["match-pending-count"],
        queryFn: async () => {
            try {
                const res = await fetch("/api/match/candidates?status=pending&limit=0");
                if (!res.ok) {
                    return 0;
                }

                const body = (await res.json()) as { total?: number; candidates?: unknown[] } | unknown[];
                if (Array.isArray(body)) {
                    return body.length;
                }

                if (typeof body.total === "number") {
                    return body.total;
                }

                if (Array.isArray(body.candidates)) {
                    return body.candidates.length;
                }

                return 0;
            } catch {
                return 0;
            }
        },
        refetchInterval: 60_000,
        staleTime: 30_000,
    });

    return q.data ?? 0;
}
