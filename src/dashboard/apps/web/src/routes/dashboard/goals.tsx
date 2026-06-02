import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

// FOUNDATION STUB — a feature agent replaces the body of GoalsPage with the real
// page. The route path, file location, and nav entry are pre-wired so routeTree
// stays stable during the parallel build. Do NOT change the createFileRoute path.
export const Route = createFileRoute("/dashboard/goals")({
    component: GoalsPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function GoalsPage() {
    return (
        <DashboardLayout title="Goals & OKRs" description="Set quarterly goals and track key results">
            <div data-testid="goals-page" className="text-muted-foreground">
                Coming soon.
            </div>
        </DashboardLayout>
    );
}
