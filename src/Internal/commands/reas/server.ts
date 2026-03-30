import { getAllDistrictNames, getPrahaDistrictNames, searchDistricts } from "./data/districts";
import { buildDashboardExport } from "./lib/api-export";

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
                const district = url.searchParams.get("district");
                const type = url.searchParams.get("type");

                if (!district || !type) {
                    return Response.json(
                        { error: "Required params: district, type" },
                        { status: 400, headers: CORS_HEADERS }
                    );
                }

                const disposition = url.searchParams.get("disposition") ?? undefined;
                const periods = url.searchParams.get("periods") ?? "2025";
                const price = url.searchParams.get("price") ?? "0";
                const area = url.searchParams.get("area") ?? "0";
                const rent = url.searchParams.get("rent") ?? "0";
                const costs = url.searchParams.get("costs") ?? "0";

                try {
                    const { buildFromFlags, fetchAndAnalyze } = await import("./index");

                    const config = await buildFromFlags({
                        district,
                        type,
                        disposition,
                        periods,
                        price,
                        area,
                        rent,
                        monthlyCosts: costs,
                    });

                    const analysis = await fetchAndAnalyze(config.filters, config.target, false);
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
