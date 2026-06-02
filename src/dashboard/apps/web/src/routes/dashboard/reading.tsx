import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

// FOUNDATION STUB — a feature agent replaces the body of ReadingPage with the real
// page. The route path, file location, and nav entry are pre-wired so routeTree
// stays stable during the parallel build. Do NOT change the createFileRoute path.
export const Route = createFileRoute("/dashboard/reading")({
    component: ReadingPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function ReadingPage() {
    return (
        <DashboardLayout title="Reading List" description="Your books, articles, progress and highlights">
            <div data-testid="reading-page" className="text-muted-foreground">
                Coming soon.
            </div>
        </DashboardLayout>
    );
}
