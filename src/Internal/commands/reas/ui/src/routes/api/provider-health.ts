import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/provider-health")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const days = Number(url.searchParams.get("days") ?? 30);
                const logLimit = Number(url.searchParams.get("logLimit") ?? 50);

                const health = reasDatabase.getProviderHealth(days);
                const recentLog = reasDatabase.getRecentFetchLog(logLimit);

                return Response.json({ health, recentLog });
            }),
        },
    },
});
