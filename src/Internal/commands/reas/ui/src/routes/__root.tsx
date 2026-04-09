import { createRootRoute, HeadContent, Outlet, Scripts, useRouter, useRouterState } from "@tanstack/react-router";
import { DashboardLayout } from "@ui/layouts/DashboardLayout";
import { Activity, BarChart3, Building2, Clock, GitCompare, Search, Star } from "lucide-react";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";

const navLinks = [
    { label: "Analyze", href: "/analyze", icon: <Search className="w-3.5 h-3.5" /> },
    { label: "Listings", href: "/listings", icon: <Building2 className="w-3.5 h-3.5" /> },
    { label: "Compare", href: "/compare", icon: <GitCompare className="w-3.5 h-3.5" /> },
    { label: "Watchlist", href: "/watchlist", icon: <Star className="w-3.5 h-3.5" /> },
    { label: "History", href: "/history", icon: <Clock className="w-3.5 h-3.5" /> },
    { label: "Health", href: "/health", icon: <Activity className="w-3.5 h-3.5" /> },
];

export const Route = createRootRoute({
    head: () => ({
        title: "GenesisTools - REAS Analyzer",
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { name: "theme-color", content: "#050508" },
            { name: "description", content: "REAS Real Estate Analyzer Dashboard" },
        ],
        links: [{ rel: "stylesheet", href: appCss }],
    }),
    shellComponent: RootDocument,
    component: RootComponent,
});

function RootDocument({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
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
        <>
            <ReasLayout />
            <Toaster
                theme="dark"
                toastOptions={{
                    style: {
                        background: "#1a1a2e",
                        border: "1px solid rgba(245, 158, 11, 0.2)",
                        color: "#e5e7eb",
                        fontFamily: "monospace",
                    },
                }}
            />
        </>
    );
}

function ReasLayout() {
    const router = useRouter();
    const location = useRouterState({ select: (s) => s.location });
    const currentPath = `/${location.pathname.split("/")[1] || ""}`;

    return (
        <DashboardLayout
            title="REAS"
            titleAccent="Analyzer"
            icon={<BarChart3 className="w-4 h-4 text-amber-400" />}
            navLinks={navLinks}
            activePath={currentPath}
            onNavigate={(href: string) => router.navigate({ to: href })}
        >
            <Outlet />
        </DashboardLayout>
    );
}
