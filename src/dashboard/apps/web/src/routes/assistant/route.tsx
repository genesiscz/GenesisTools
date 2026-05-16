import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireAuthBeforeLoad } from "@/lib/auth/requireUser";

export const Route = createFileRoute("/assistant")({
    beforeLoad: ({ location }) => requireAuthBeforeLoad(location.href),
    component: () => <Outlet />,
});
