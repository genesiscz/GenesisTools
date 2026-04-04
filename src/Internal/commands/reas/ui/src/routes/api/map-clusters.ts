import { reasClient } from "@app/Internal/commands/reas/api/ReasClient";
import { resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import type { AnalysisFilters, DateRange } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/map-clusters")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const districtName = url.searchParams.get("district") ?? "Praha 2";
                const from = url.searchParams.get("from") ?? "2025-01-01";
                const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10);
                const constructionType = url.searchParams.get("type") ?? "brick";

                const district = resolveDistrict(districtName);
                const dateRange: DateRange = {
                    label: `${from} – ${to}`,
                    from: new Date(from),
                    to: new Date(to),
                };

                const filters: AnalysisFilters = {
                    estateType: "flat",
                    constructionType,
                    periods: [dateRange],
                    district,
                };

                const boundsParam = url.searchParams.get("bounds");

                if (boundsParam) {
                    try {
                        filters.bounds = SafeJSON.parse(boundsParam);
                    } catch {
                        return Response.json({ error: "Invalid bounds JSON" }, { status: 400 });
                    }
                }

                const data = await reasClient.fetchPointersAndClusters(filters, dateRange);

                return Response.json({ data });
            }),
        },
    },
});
