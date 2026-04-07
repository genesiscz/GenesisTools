import { fetchMapClusters } from "@app/Internal/commands/reas/lib/map-service";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/map-clusters")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const district = url.searchParams.get("district") ?? "Praha 2";
                const from = url.searchParams.get("from") ?? "2025-01-01";
                const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
                const constructionType = url.searchParams.get("type") ?? "brick";

                let bounds: ReturnType<typeof SafeJSON.parse> | undefined;
                const boundsParam = url.searchParams.get("bounds");

                if (boundsParam) {
                    try {
                        bounds = SafeJSON.parse(boundsParam);
                    } catch {
                        return Response.json({ error: "Invalid bounds JSON" }, { status: 400 });
                    }
                }

                const data = await fetchMapClusters({ district, from, to, constructionType, bounds });

                return Response.json({ data });
            }),
        },
    },
});
