import {
    Outlet,
    RouterProvider,
    createHashHistory,
    createRouter,
    createRootRoute,
    createRoute,
    useRouterState,
} from "@tanstack/react-router";
import { DashboardLayout } from "@ui/layouts/DashboardLayout";
import { Settings, ArrowDownToLine, ArrowUpFromLine, Link2 } from "lucide-react";
import { IndexPage } from "./routes/index";
import { MappingsPage } from "./routes/mappings";
import { ExportPage } from "./routes/export";
import { ImportPage } from "./routes/import";
import { SettingsPage } from "./routes/settings";

const navLinks = [
    { label: "MAPPINGS", href: "/mappings", icon: <Link2 className="w-3.5 h-3.5" /> },
    { label: "EXPORT", href: "/export", icon: <ArrowDownToLine className="w-3.5 h-3.5" /> },
    { label: "IMPORT", href: "/import", icon: <ArrowUpFromLine className="w-3.5 h-3.5" /> },
    { label: "SETTINGS", href: "/settings", icon: <Settings className="w-3.5 h-3.5" /> },
];

const rootRoute = createRootRoute({
    component: function RootLayout() {
        const location = useRouterState({ select: (s) => s.location });
        const currentPath = `/${location.pathname.split("/")[1] || ""}`;

        return (
            <DashboardLayout
                title="CLARITY"
                titleAccent="TIMELOG"
                navLinks={navLinks}
                activePath={currentPath}
                onNavigate={(href) => routerInstance.navigate({ to: href })}
            >
                <Outlet />
            </DashboardLayout>
        );
    },
});

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: IndexPage,
});

const mappingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/mappings",
    component: MappingsPage,
});

const exportRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/export",
    component: ExportPage,
});

const importRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/import",
    component: ImportPage,
});

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    mappingsRoute,
    exportRoute,
    importRoute,
    settingsRoute,
]);

const hashHistory = createHashHistory();

const routerInstance = createRouter({
    routeTree,
    history: hashHistory,
});

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof routerInstance;
    }
}

export function App() {
    return <RouterProvider router={routerInstance} />;
}
