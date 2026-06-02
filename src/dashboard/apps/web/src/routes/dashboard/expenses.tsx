import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "@/components/dashboard";
import { RouteError } from "@/components/RouteError";
import { RouteSkeleton } from "@/components/RouteSkeleton";

// FOUNDATION STUB — a feature agent replaces the body of ExpensesPage with the real
// page. The route path, file location, and nav entry are pre-wired so routeTree
// stays stable during the parallel build. Do NOT change the createFileRoute path.
export const Route = createFileRoute("/dashboard/expenses")({
    component: ExpensesPage,
    errorComponent: ({ error, reset }) => <RouteError error={error} reset={reset} />,
    pendingComponent: () => <RouteSkeleton />,
});

function ExpensesPage() {
    return (
        <DashboardLayout title="Expenses" description="Track spending and see where money goes">
            <div data-testid="expenses-page" className="text-muted-foreground">
                Coming soon.
            </div>
        </DashboardLayout>
    );
}
