import { Loader2 } from "lucide-react";

/**
 * Shared route-level pending fallback. Prevents a blank flash while a route
 * loader resolves (SSR → hydration).
 */
export function RouteSkeleton({ label = "Loading…" }: { label?: string }) {
    return (
        <div className="flex min-h-[60vh] items-center justify-center">
            <div className="flex flex-col items-center gap-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="font-mono text-sm text-muted-foreground">{label}</span>
            </div>
        </div>
    );
}
