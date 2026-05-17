import { createFileRoute } from "@tanstack/react-router";
import { sqlite } from "@/drizzle";

/**
 * Liveness + DB-readiness probe for PM2 / uptime monitors. Runs a trivial
 * `SELECT 1` so a 200 means "process up AND sqlite handle usable", which a
 * bare TCP check cannot distinguish.
 */
export const Route = createFileRoute("/api/health")({
    server: {
        handlers: {
            GET: () => {
                try {
                    sqlite.prepare("SELECT 1").get();
                    return Response.json({ status: "ok", db: "ok" });
                } catch (err) {
                    return Response.json(
                        { status: "error", db: err instanceof Error ? err.message : String(err) },
                        { status: 503 }
                    );
                }
            },
        },
    },
});
