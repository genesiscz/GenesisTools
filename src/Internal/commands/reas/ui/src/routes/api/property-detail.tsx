import { buildDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/property-detail")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idParam = url.searchParams.get("id");

                if (!idParam) {
                    return Response.json({ error: "Missing required parameter: id" }, { status: 400 });
                }

                const id = Number(idParam);

                if (Number.isNaN(id)) {
                    return Response.json({ error: "Invalid id parameter" }, { status: 400 });
                }

                const property = reasDatabase.getProperty(id);

                if (!property) {
                    return Response.json({ error: "Property not found" }, { status: 404 });
                }

                const history = reasDatabase.getPropertyAnalysisHistory(id);
                const analysis = property.last_analysis_json
                    ? (SafeJSON.parse(property.last_analysis_json) as FullAnalysis)
                    : null;

                return Response.json({
                    property,
                    history,
                    analysis,
                    exportData: analysis ? buildDashboardExport(analysis) : null,
                });
            }),
        },
    },
});
