import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

export const Route = createFileRoute("/api/analysis")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const districtName = body.district as string | undefined;
                const type = body.type as string | undefined;
                const price = body.price as string | undefined;
                const area = body.area as string | undefined;

                if (!districtName || !type || !price || !area) {
                    return Response.json(
                        { error: "Missing required fields: district, type, price, area" },
                        { status: 400 }
                    );
                }

                const district = resolveDistrict(districtName);

                const { filters, target } = buildConfig({
                    district,
                    constructionType: type,
                    disposition: body.disposition as string | undefined,
                    periodsStr: body.periods as string | undefined,
                    price: Number(price),
                    area: Number(area),
                    rent: body.rent ? Number(body.rent) : undefined,
                    monthlyCosts: body.monthlyCosts ? Number(body.monthlyCosts) : undefined,
                    priceMin: body.priceMin as string | undefined,
                    priceMax: body.priceMax as string | undefined,
                    areaMin: body.areaMin as string | undefined,
                    areaMax: body.areaMax as string | undefined,
                    providers: body.providers as string | undefined,
                });

                const refresh = body.refresh === true;
                const analysis = await fetchAndAnalyze(filters, target, refresh);
                const exportData = buildDashboardExport(analysis);

                return Response.json(exportData);
            }),
        },
    },
});
