import {
    getAllDistrictNames,
    getPrahaDistrictNames,
    searchDistricts,
} from "@app/Internal/commands/reas/data/districts";
import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";

const DEFAULT_PORT = 3456;

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
};

export async function startServer(port = DEFAULT_PORT): Promise<void> {
    const server = Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);

            if (req.method === "OPTIONS") {
                return new Response(null, { headers: CORS_HEADERS });
            }

            if (url.pathname === "/api/districts") {
                return Response.json(
                    { districts: getAllDistrictNames(), praha: getPrahaDistrictNames() },
                    { headers: CORS_HEADERS }
                );
            }

            if (url.pathname === "/api/search") {
                const q = url.searchParams.get("q") ?? "";
                const results = searchDistricts(q);
                return Response.json(results, { headers: CORS_HEADERS });
            }

            if (url.pathname === "/api/analysis") {
                const districtParam = url.searchParams.get("district");
                const type = url.searchParams.get("type");

                if (!districtParam || !type) {
                    return Response.json(
                        { error: "Required params: district, type" },
                        { status: 400, headers: CORS_HEADERS }
                    );
                }

                const disposition = url.searchParams.get("disposition") ?? undefined;
                const periods = url.searchParams.get("periods") ?? String(new Date().getFullYear());
                const price = url.searchParams.get("price") ?? "0";
                const area = url.searchParams.get("area") ?? "0";
                const rent = url.searchParams.get("rent") ?? "0";
                const costs = url.searchParams.get("costs") ?? "0";

                try {
                    const district = resolveDistrict(districtParam);
                    const { filters, target } = buildConfig({
                        district,
                        constructionType: type,
                        disposition,
                        periodsStr: periods,
                        price: Number(price),
                        area: Number(area),
                        rent: Number(rent),
                        monthlyCosts: Number(costs),
                    });

                    const analysis = await fetchAndAnalyze(filters, target, false);
                    const exportData = buildDashboardExport(analysis);

                    return Response.json(exportData, { headers: CORS_HEADERS });
                } catch (error) {
                    console.error("Analysis error:", error);
                    return Response.json({ error: "Analysis failed" }, { status: 500, headers: CORS_HEADERS });
                }
            }

            return Response.json({ error: "Not found" }, { status: 404, headers: CORS_HEADERS });
        },
    });

    console.log(`REAS Dashboard API running at http://localhost:${server.port}`);
    console.log(`  GET /api/districts  - list all districts`);
    console.log(`  GET /api/search?q=  - search districts`);
    console.log(`  GET /api/analysis?district=Praha&type=brick&... - run analysis`);
}
