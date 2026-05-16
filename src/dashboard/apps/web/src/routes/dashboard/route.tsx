import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireAuthBeforeLoad } from "@/lib/auth/requireUser";

export const Route = createFileRoute("/dashboard")({
    beforeLoad: ({ location }) => requireAuthBeforeLoad(location.href),
    component: () => <Outlet />,
});
