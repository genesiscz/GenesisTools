import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceSplit } from "@app/shops/ui/components/WorkspaceSplit";

export const Route = createFileRoute("/workspace")({
    component: WorkspacePage,
});

function WorkspacePage() {
    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Workspace :: <span className="text-foreground">Search + Detail</span>
            </h1>
            <WorkspaceSplit />
        </div>
    );
}
