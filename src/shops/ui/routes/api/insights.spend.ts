import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import {
    counterfactualSavings,
    monthlySpend,
    spendByCategory,
    spendByShop,
    topProducts,
} from "@app/shops/lib/analytics/spend";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/insights/spend")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const db = getShopsDatabase();
                const [months, byShop, byCategory, top, counterfactual] = await Promise.all([
                    monthlySpend(db, userId, { months: 12 }),
                    spendByShop(db, userId),
                    spendByCategory(db, userId, { limit: 10 }),
                    topProducts(db, userId, { limit: 10 }),
                    counterfactualSavings(db, userId, { sinceDays: 90 }),
                ]);
                return Response.json({ months, byShop, byCategory, topProducts: top, counterfactual });
            }),
        },
    },
});
