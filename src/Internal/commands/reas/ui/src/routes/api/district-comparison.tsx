import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import { serializeDistrictSnapshot } from "@app/Internal/commands/reas/lib/district-snapshot";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

export const Route = createFileRoute("/api/district-comparison")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const districts = Array.isArray(body.districts)
                    ? body.districts.filter((value): value is string => typeof value === "string")
                    : [];

                if (districts.length === 0) {
                    return Response.json({ error: "Missing required field: districts" }, { status: 400 });
                }

                const constructionType = (body.type as string | undefined) ?? "brick";
                const disposition = body.disposition as string | undefined;
                const price = Number(body.price ?? 5000000);
                const area = Number(body.area ?? 80);

                const comparisons = await Promise.all(
                    districts.map(async (districtName) => {
                        const district = resolveDistrict(districtName);
                        const { filters, target } = buildConfig({
                            district,
                            constructionType,
                            disposition,
                            periodsStr: body.periods as string | undefined,
                            price,
                            area,
                            rent: body.rent ? Number(body.rent) : undefined,
                            monthlyCosts: body.monthlyCosts ? Number(body.monthlyCosts) : undefined,
                            providers: body.providers as string | undefined,
                        });
                        const analysis = await fetchAndAnalyze(filters, target, body.refresh === true);
                        const exportData = buildDashboardExport(analysis);
                        const snapshots = reasDatabase
                            .getDistrictHistory(district.name, constructionType, 730)
                            .map(serializeDistrictSnapshot);

                        return {
                            district: district.name,
                            exportData,
                            snapshots,
                            summary: {
                                medianPricePerM2: exportData.analysis.comparables.median,
                                grossYield: exportData.analysis.yield.grossYield,
                                netYield: exportData.analysis.yield.netYield,
                                daysOnMarket: exportData.analysis.timeOnMarket.median,
                                targetPercentile: exportData.analysis.comparables.targetPercentile,
                                salesCount: exportData.listings.sold.length,
                                rentalCount: exportData.listings.rentals.length,
                            },
                        };
                    })
                );

                return Response.json({ comparisons });
            }),
        },
    },
});
