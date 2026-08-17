import { FilterBar } from "@app/spotify/ui/components/FilterBar";
import { FiltersProvider } from "@app/spotify/ui/lib/filters";
import appCss from "@app/spotify/ui/styles.css?url";
import { DashboardLayout } from "@genesiscz/utils/ui/layouts/DashboardLayout";
import { createRootRoute, HeadContent, Outlet, Scripts, useRouter, useRouterState } from "@tanstack/react-router";
import {
    Activity,
    CalendarClock,
    Disc3,
    Fingerprint,
    Gift,
    Heart,
    LayoutDashboard,
    Search,
    Settings,
    Sparkles,
    Trophy,
} from "lucide-react";
import type { ReactNode } from "react";

const navLinks = [
    { label: "Overview", href: "/", icon: <LayoutDashboard className="w-3.5 h-3.5" /> },
    { label: "Rankings", href: "/top", icon: <Trophy className="w-3.5 h-3.5" /> },
    { label: "Time", href: "/time", icon: <CalendarClock className="w-3.5 h-3.5" /> },
    { label: "Habits", href: "/habits", icon: <Activity className="w-3.5 h-3.5" /> },
    { label: "Biography", href: "/biography", icon: <Sparkles className="w-3.5 h-3.5" /> },
    { label: "Library", href: "/library", icon: <Heart className="w-3.5 h-3.5" /> },
    { label: "DNA", href: "/dna", icon: <Fingerprint className="w-3.5 h-3.5" /> },
    { label: "Wrapped", href: "/wrapped", icon: <Disc3 className="w-3.5 h-3.5" /> },
    { label: "Together", href: "/together", icon: <Gift className="w-3.5 h-3.5" /> },
    { label: "Explore", href: "/explore", icon: <Search className="w-3.5 h-3.5" /> },
    { label: "Settings", href: "/settings", icon: <Settings className="w-3.5 h-3.5" /> },
];

export const Route = createRootRoute({
    notFoundComponent: () => (
        <div className="p-12 text-center text-muted-foreground font-mono">
            <div className="text-2xl text-primary tracking-[0.3em] mb-2">404</div>
            <div className="text-sm">no route bound to this path</div>
        </div>
    ),
    head: () => ({
        title: "GenesisTools · Spotify",
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { name: "theme-color", content: "#0d0d14" },
            {
                name: "description",
                content: "Listening analytics over your own Spotify export, plus two-person taste compatibility",
            },
        ],
        links: [{ rel: "stylesheet", href: appCss }],
    }),
    shellComponent: RootDocument,
    component: RootComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
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
        <FiltersProvider>
            <SpotifyLayout>
                <Outlet />
            </SpotifyLayout>
        </FiltersProvider>
    );
}

function SpotifyLayout({ children }: { children: ReactNode }) {
    const router = useRouter();
    const location = useRouterState({ select: (s) => s.location });
    const segments = location.pathname.split("/").filter(Boolean);
    const currentPath = segments.length > 0 ? `/${segments[0]}` : "/";

    return (
        <DashboardLayout
            title="SPOTIFY"
            titleAccent="LIFE"
            icon={<Disc3 className="w-4 h-4 text-primary" />}
            navLinks={navLinks}
            activePath={currentPath}
            onNavigate={(href: string) => router.navigate({ to: href })}
            rightSlot={<FilterBar />}
        >
            <div className="max-w-6xl mx-auto px-3 sm:px-6 py-6">{children}</div>
        </DashboardLayout>
    );
}
