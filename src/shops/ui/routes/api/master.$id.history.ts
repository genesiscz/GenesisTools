import { logger } from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { bestWeekday } from "@app/shops/lib/analytics/best-time";
import type { PriceHistoryPoint, PriceHistoryResponse } from "@app/shops/types";
import { apiHandler, intParam } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "kysely";

const log = logger.child({ component: "api:master:$id:history" });

export const Route = createFileRoute("/api/master/$id/history")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const segments = url.pathname.split("/");
                const idStr = segments[segments.length - 2] ?? "";
                const id = Number(idStr);
                if (!Number.isInteger(id) || id <= 0) {
                    return Response.json({ error: `Invalid master id: ${idStr}` }, { status: 400 });
                }

                // Default 365d so the chart shows a full year out of the box.
                // Cap at 10y to fit hlidacshopu's full historical depth — they
                // mirror prices back to 2018 for some products.
                let days: number;
                try {
                    days = intParam(url.searchParams, "days", 365, { min: 1, max: 3650 });
                } catch (err) {
                    return Response.json({ error: (err as Error).message }, { status: 400 });
                }

                const includeStats = url.searchParams.get("stats") === "1";
                const best_weekday = includeStats ? await bestWeekday(getShopsDatabase(), id) : null;

                const rows = await getShopsDatabase()
                    .kysely()
                    .selectFrom("prices as pr")
                    .innerJoin("products as p", "p.id", "pr.product_id")
                    .select((eb) => [
                        sql<string>`substr(pr.observed_at, 1, 10)`.as("day"),
                        "p.shop_origin",
                        eb.fn.avg<number>("pr.current_price").as("avg_price"),
                    ])
                    .where("p.master_product_id", "=", id)
                    .where("pr.current_price", "is not", null)
                    .where("pr.observed_at", ">=", sql<string>`date('now', ${`-${days} day`})`)
                    .groupBy([sql`substr(pr.observed_at, 1, 10)`, "p.shop_origin"])
                    .orderBy("day", "asc")
                    .execute();

                if (rows.length === 0) {
                    const today = new Date().toISOString().slice(0, 10);
                    const body: PriceHistoryResponse = {
                        shops: [],
                        points: [],
                        range: { from: today, to: today },
                    };
                    return Response.json({ ...body, best_weekday });
                }

                const shops = Array.from(new Set(rows.map((r) => r.shop_origin))).sort();
                const days_set = Array.from(new Set(rows.map((r) => r.day))).sort();
                const pointsMap = new Map<string, PriceHistoryPoint>();
                for (const d of days_set) {
                    const point: PriceHistoryPoint = { date: d };
                    for (const s of shops) {
                        point[s] = null;
                    }

                    pointsMap.set(d, point);
                }

                for (const r of rows) {
                    const p = pointsMap.get(r.day);
                    if (p) {
                        p[r.shop_origin] = r.avg_price;
                    }
                }

                const points = Array.from(pointsMap.values());
                const body: PriceHistoryResponse = {
                    shops,
                    points,
                    range: { from: days_set[0], to: days_set[days_set.length - 1] },
                };

                log.debug({ id, days, shops: shops.length, points: points.length }, "api: history served");
                return Response.json({ ...body, best_weekday });
            }),
        },
    },
});
