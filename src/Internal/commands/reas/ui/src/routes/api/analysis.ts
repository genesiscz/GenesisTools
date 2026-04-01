import { createFileRoute } from "@tanstack/react-router";
import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import { apiHandler, jsonBody } from "../../server/api-utils";

interface AnalysisRequest {
    district: string;
    type: string;
    price: string;
    area: string;
    disposition?: string;
    periods?: string;
    rent?: string;
    monthlyCosts?: string;
    priceMin?: string;
    priceMax?: string;
    areaMin?: string;
    areaMax?: string;
    providers?: string;
    refresh?: boolean;
}

export const Route = createFileRoute("/api/analysis")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const params = body as unknown as AnalysisRequest;

                if (!params.district || !params.type || !params.price || !params.area) {
                    return Response.json(
                        { error: "Missing required fields: district, type, price, area" },
                        { status: 400 },
                    );
                }

                const district = resolveDistrict(params.district);

                const { filters, target } = buildConfig({
                    district,
                    constructionType: params.type,
                    disposition: params.disposition,
                    periodsStr: params.periods,
                    price: Number(params.price),
                    area: Number(params.area),
                    rent: params.rent ? Number(params.rent) : undefined,
                    monthlyCosts: params.monthlyCosts ? Number(params.monthlyCosts) : undefined,
                    priceMin: params.priceMin,
                    priceMax: params.priceMax,
                    areaMin: params.areaMin,
                    areaMax: params.areaMax,
                    providers: params.providers,
                });

                const analysis = await fetchAndAnalyze(filters, target, params.refresh ?? false);
                const exportData = buildDashboardExport(analysis);

                return Response.json(exportData);
            }),
        },
    },
});
