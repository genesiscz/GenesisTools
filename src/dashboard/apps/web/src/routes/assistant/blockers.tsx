import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

// FOUNDATION STUB — a feature agent replaces the body of BlockersPage with the real
// page. The route path, file location, and nav entry are pre-wired so routeTree
// stays stable during the parallel build. Do NOT change the createFileRoute path.
export const Route = createFileRoute("/assistant/blockers")({
    component: BlockersPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function BlockersPage() {
    return (
        <DashboardLayout title="Blockers" description="Track what's blocking your work">
            <div data-testid="blockers-page" className="text-muted-foreground">
                Coming soon.
            </div>
        </DashboardLayout>
    );
}
