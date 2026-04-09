import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDistrictPreseedConfig, runDistrictPreseed } from "@app/Internal/commands/reas/lib/district-preseed";
import {
    collapseDistrictSnapshots,
    type DistrictSnapshotResolution,
} from "@app/Internal/commands/reas/lib/district-snapshot";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

function parseSnapshotResolution(value: string | null): DistrictSnapshotResolution {
    return value === "monthly" ? "monthly" : "daily";
}

export const Route = createFileRoute("/api/district-snapshots")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const district = url.searchParams.get("district");
                const districts = url.searchParams
                    .get("districts")
                    ?.split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                const constructionType = url.searchParams.get("type") ?? "brick";
                const disposition = url.searchParams.get("disposition")?.trim() || undefined;
                const days = url.searchParams.get("days");
                const historyDays = days ? Number(days) : 365;
                const resolution = parseSnapshotResolution(url.searchParams.get("resolution"));

                if (!district && (!districts || districts.length === 0)) {
                    return Response.json(
                        { error: "Missing required parameter: district or districts" },
                        { status: 400 }
                    );
                }

                if (districts && districts.length > 0) {
                    const snapshotsByDistrict = Object.fromEntries(
                        districts.map((districtName) => [
                            districtName,
                            collapseDistrictSnapshots({
                                rows: reasDatabase.getDistrictHistory(
                                    districtName,
                                    constructionType,
                                    historyDays,
                                    disposition
                                ),
                                resolution,
                            }),
                        ])
                    );

                    return Response.json({ snapshotsByDistrict });
                }

                const snapshots = reasDatabase.getDistrictHistory(
                    district!,
                    constructionType,
                    historyDays,
                    disposition
                );

                const rows = collapseDistrictSnapshots({
                    rows: snapshots,
                    resolution,
                });

                return Response.json({ snapshots: rows });
            }),

            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (body.action !== "preseed-praha") {
                    return Response.json({ error: "Unsupported action" }, { status: 400 });
                }

                const constructionType = typeof body.type === "string" ? body.type : "brick";
                const disposition = typeof body.disposition === "string" ? body.disposition : undefined;
                const periods = typeof body.periods === "string" ? body.periods : undefined;
                const price = Number(body.price ?? 5000000);
                const area = Number(body.area ?? 80);
                const rent = typeof body.rent === "number" ? body.rent : undefined;
                const monthlyCosts = typeof body.monthlyCosts === "number" ? body.monthlyCosts : undefined;
                const providers = typeof body.providers === "string" ? body.providers : undefined;

                const result = await runDistrictPreseed({
                    analyzeDistrict: async (district) => {
                        const { filters, target } = buildDistrictPreseedConfig({
                            district,
                            constructionType,
                            disposition,
                            periods,
                            price,
                            area,
                            rent,
                            monthlyCosts,
                            providers,
                        });

                        await fetchAndAnalyze(filters, target, body.refresh === true);
                    },
                });

                return Response.json(result);
            }),
        },
    },
});
