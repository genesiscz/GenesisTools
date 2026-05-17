import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { requireAuthBeforeLoad } from "@/lib/auth/requireUser";

export const Route = createFileRoute("/dashboard")({
    beforeLoad: ({ location }) => requireAuthBeforeLoad(location.href),
    component: () => <Outlet />,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});
