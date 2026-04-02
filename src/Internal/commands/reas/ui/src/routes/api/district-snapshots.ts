import { serializeDistrictSnapshot } from "@app/Internal/commands/reas/lib/district-snapshot";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/district-snapshots")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const district = url.searchParams.get("district");
                const constructionType = url.searchParams.get("type") ?? "brick";
                const days = url.searchParams.get("days");

                if (!district) {
                    return Response.json({ error: "Missing required parameter: district" }, { status: 400 });
                }

                const snapshots = reasDatabase.getDistrictHistory(
                    district,
                    constructionType,
                    days ? Number(days) : 365
                );

                const rows = snapshots.map(serializeDistrictSnapshot);

                return Response.json({ snapshots: rows });
            }),
        },
    },
});
