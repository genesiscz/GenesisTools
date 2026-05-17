import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "kysely";

interface SparklinePoint {
    d: string;
    c: number | null;
}

export const Route = createFileRoute("/api/insights/sparklines")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, _userId) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const ids = Array.isArray(body.master_ids)
                    ? body.master_ids.filter((x): x is number => typeof x === "number")
                    : [];
                const days = typeof body.days === "number" ? Math.min(body.days, 90) : 30;
                if (ids.length === 0) {
                    return Response.json({});
                }

                const rows = await getShopsDatabase()
                    .kysely()
                    .selectFrom("prices as p")
                    .innerJoin("products as pr", "pr.id", "p.product_id")
                    .where("pr.master_product_id", "in", ids)
                    .where("p.observed_at", ">=", sql<string>`datetime('now', ${`-${days} days`})`)
                    .where("p.current_price", "is not", null)
                    .select([
                        "pr.master_product_id as master_product_id",
                        sql<string>`date(p.observed_at)`.as("d"),
                        sql<number>`MIN(p.current_price)`.as("c"),
                    ])
                    .groupBy("pr.master_product_id")
                    .groupBy("d")
                    .orderBy("d", "asc")
                    .execute();

                const out: Record<number, SparklinePoint[]> = {};
                for (const id of ids) {
                    out[id] = [];
                }

                for (const r of rows) {
                    if (r.master_product_id === null) {
                        continue;
                    }

                    out[r.master_product_id].push({ d: r.d, c: r.c });
                }

                return Response.json(out);
            }),
        },
    },
});
