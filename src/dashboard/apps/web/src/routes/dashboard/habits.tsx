import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

// FOUNDATION STUB — a feature agent replaces the body of HabitsPage with the real
// page. The route path, file location, and nav entry are pre-wired so routeTree
// stays stable during the parallel build. Do NOT change the createFileRoute path.
export const Route = createFileRoute("/dashboard/habits")({
    component: HabitsPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function HabitsPage() {
    return (
        <DashboardLayout title="Habits" description="Build streaks and track daily habits">
            <div data-testid="habits-page" className="text-muted-foreground">
                Coming soon.
            </div>
        </DashboardLayout>
    );
}
