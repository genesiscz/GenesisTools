import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/assistant/")({
    beforeLoad: () => {
        throw redirect({ to: "/assistant/tasks" });
    },
    component: () => null,
});
