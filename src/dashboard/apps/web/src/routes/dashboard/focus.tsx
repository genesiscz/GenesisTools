import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";
import { FocusHero } from "./-focus/FocusHero";

export const Route = createFileRoute("/dashboard/focus")({
    component: FocusModePage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function FocusModePage() {
    return (
        <DashboardLayout title="Focus Mode" description="Deep work sessions with Pomodoro technique">
            <FocusHero />
        </DashboardLayout>
    );
}
