import { createRootRoute, HeadContent, Outlet, Scripts, useRouter, useRouterState } from "@tanstack/react-router";
import { DashboardLayout } from "@ui/layouts/DashboardLayout";
import { ArrowDownToLine, ArrowUpFromLine, Link2, Settings } from "lucide-react";
import { Toaster } from "sonner";
import { AppProvider } from "../context/AppContext";
import appCss from "../styles.css?url";

const navLinks = [
    { label: "Mappings", href: "/mappings", icon: <Link2 className="w-3.5 h-3.5" /> },
    { label: "Export", href: "/export", icon: <ArrowDownToLine className="w-3.5 h-3.5" /> },
    { label: "Import", href: "/import", icon: <ArrowUpFromLine className="w-3.5 h-3.5" /> },
    { label: "Settings", href: "/settings", icon: <Settings className="w-3.5 h-3.5" /> },
];

export const Route = createRootRoute({
    head: () => ({
        title: "GenesisTools - Clarity Timelog",
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { name: "theme-color", content: "#050508" },
            { name: "description", content: "Clarity Timelog Dashboard" },
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
        <AppProvider>
            <ClarityLayout />
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
        </AppProvider>
    );
}

function ClarityLayout() {
    const router = useRouter();
    const location = useRouterState({ select: (s) => s.location });
    const currentPath = `/${location.pathname.split("/")[1] || ""}`;

    return (
        <DashboardLayout
            title="Clarity"
            titleAccent="Timelog"
            navLinks={navLinks}
            activePath={currentPath}
            onNavigate={(href: string) => router.navigate({ to: href })}
        >
            <Outlet />
        </DashboardLayout>
    );
}
