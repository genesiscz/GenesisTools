import { Link } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import { AlertTriangle } from "lucide-react";

interface RouteErrorProps {
    error: Error;
    reset?: () => void;
}

/**
 * Shared error fallback for the root and every data route. Replaces the
 * default blank white-screen + console stack when a loader/render throws
 * (server down, SQLite locked, auth failure).
 */
export function RouteError({ error, reset }: RouteErrorProps) {
    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border border-rose-500/30 bg-rose-500/10">
                <AlertTriangle className="h-8 w-8 text-rose-400" />
            </div>

            <div className="space-y-2">
                <h1 className="font-mono text-xl font-bold text-foreground">Something went wrong</h1>
                <p className="max-w-md text-sm text-muted-foreground">
                    {error?.message || "An unexpected error occurred while loading this page."}
                </p>
            </div>

            <div className="flex items-center gap-3">
                {reset && (
                    <Button variant="brand" onClick={() => reset()}>
                        Try again
                    </Button>
                )}
                <Button variant="outline" asChild>
                    <Link to="/dashboard">Back to dashboard</Link>
                </Button>
            </div>
        </div>
    );
}
