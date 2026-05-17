import { Link } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { Compass } from "lucide-react";

/**
 * 404 fallback — distinct from RouteError (which is for thrown errors). No
 * "Try again" affordance: a missing route is not a transient failure.
 */
export function RouteNotFound() {
    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10">
                <Compass className="h-8 w-8 text-cyan-400" />
            </div>

            <div className="space-y-2">
                <h1 className="font-mono text-xl font-bold text-foreground">Page not found</h1>
                <p className="max-w-md text-sm text-muted-foreground">
                    That route doesn't exist. It may have moved, or the link is wrong.
                </p>
            </div>

            <Button variant="brand" asChild>
                <Link to="/dashboard">Back to dashboard</Link>
            </Button>
        </div>
    );
}
