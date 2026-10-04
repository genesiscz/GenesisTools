import { LiveFeed } from "@app/shops/ui/components/LiveFeed";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/live")({
    component: LivePage,
});

function LivePage() {
    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono text-sm text-muted-foreground first-letter:uppercase">
                Live :: <span className="text-foreground">Observability</span>
            </h1>
            <LiveFeed />
        </div>
    );
}
