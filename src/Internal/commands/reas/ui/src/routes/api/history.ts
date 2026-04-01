import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/history")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const district = url.searchParams.get("district") ?? undefined;
                const limit = url.searchParams.get("limit");

                const history = reasDatabase.getHistory({
                    district,
                    limit: limit ? Number(limit) : 50,
                });

                const rows = history.map((row) => ({
                    id: row.id,
                    district: row.district,
                    constructionType: row.construction_type,
                    disposition: row.disposition,
                    targetPrice: row.target_price,
                    targetArea: row.target_area,
                    medianPricePerM2: row.median_price_per_m2,
                    investmentScore: row.investment_score,
                    investmentGrade: row.investment_grade,
                    netYield: row.net_yield,
                    grossYield: row.gross_yield,
                    medianDaysOnMarket: row.median_days_on_market,
                    medianDiscount: row.median_discount,
                    comparablesCount: row.comparables_count,
                    createdAt: row.created_at,
                }));

                return Response.json({ history: rows });
            }),
        },
    },
});
