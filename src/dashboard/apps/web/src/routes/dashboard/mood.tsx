import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

// FOUNDATION STUB — a feature agent replaces the body of MoodPage with the real
// page. The route path, file location, and nav entry are pre-wired so routeTree
// stays stable during the parallel build. Do NOT change the createFileRoute path.
export const Route = createFileRoute("/dashboard/mood")({
    component: MoodPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function MoodPage() {
    return (
        <DashboardLayout title="Mood Journal" description="Daily mood check-ins and reflections">
            <div data-testid="mood-page" className="text-muted-foreground">
                Coming soon.
            </div>
        </DashboardLayout>
    );
}
