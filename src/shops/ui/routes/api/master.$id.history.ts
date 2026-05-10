import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { PriceHistoryPoint, PriceHistoryResponse } from "@app/shops/types";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, intParam } from "@app/shops/ui/server/api-utils";

const log = logger.child({ component: "api:master:$id:history" });

interface DailyRow {
    day: string;
    shop_origin: string;
    avg_price: number;
}

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

                let days: number;
                try {
                    days = intParam(url.searchParams, "days", 90, { min: 1, max: 365 });
                } catch (err) {
                    return Response.json({ error: (err as Error).message }, { status: 400 });
                }

                const db = getShopsDatabase().raw();

                const rows = db
                    .query<DailyRow, [number, number]>(
                        `SELECT
                            substr(pr.observed_at, 1, 10) AS day,
                            p.shop_origin AS shop_origin,
                            AVG(pr.current_price) AS avg_price
                         FROM prices pr
                         JOIN products p ON p.id = pr.product_id
                         WHERE p.master_product_id = ?
                           AND pr.current_price IS NOT NULL
                           AND pr.observed_at >= date('now', ? || ' day')
                         GROUP BY day, p.shop_origin
                         ORDER BY day ASC`
                    )
                    .all(id, -days);

                if (rows.length === 0) {
                    const today = new Date().toISOString().slice(0, 10);
                    const body: PriceHistoryResponse = {
                        shops: [],
                        points: [],
                        range: { from: today, to: today },
                    };
                    return Response.json(body);
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
                return Response.json(body);
            }),
        },
    },
});
