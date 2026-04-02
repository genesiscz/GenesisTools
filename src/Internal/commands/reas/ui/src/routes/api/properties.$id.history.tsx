import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/properties/$id/history")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const requestUrl = new URL(request.url);
                const routeId = requestUrl.pathname.split("/").at(-2);
                const propertyId = Number(routeId);
                const limit = Number(requestUrl.searchParams.get("limit") ?? "50");

                if (Number.isNaN(propertyId)) {
                    return Response.json({ error: "Invalid property id" }, { status: 400 });
                }

                const history = reasDatabase.getPropertyAnalysisHistory(propertyId, Number.isNaN(limit) ? 50 : limit);
                return Response.json({ history });
            }),
        },
    },
});
