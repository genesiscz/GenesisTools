import logger from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { CoverageResponse, CoverageRow } from "@app/shops/types";
import { apiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

const log = logger.child({ component: "api:coverage" });

interface ShopRow {
    origin: string;
    display_name: string;
    cap_live: number;
    cap_history: number;
    cap_listing: number;
    cap_ean: number;
    cap_search: number;
    bot_protection: string;
    product_count: number;
    last_crawl_at: string | null;
}

interface RunRow {
    id: number;
    shop_origin: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    products_seen: number;
    products_new: number;
}

export const Route = createFileRoute("/api/coverage")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const db = getShopsDatabase().raw();
                const shops = db
                    .query<ShopRow, []>(
                        `SELECT
                            s.origin, s.display_name,
                            s.cap_live, s.cap_history, s.cap_listing, s.cap_ean, s.cap_search,
                            s.bot_protection,
                            (SELECT COUNT(*) FROM products p WHERE p.shop_origin = s.origin AND p.is_active = 1) AS product_count,
                            (SELECT MAX(finished_at) FROM crawl_runs cr WHERE cr.shop_origin = s.origin) AS last_crawl_at
                         FROM shops s
                         ORDER BY s.display_name`
                    )
                    .all();

                const recentRuns = db
                    .query<RunRow, []>(
                        `SELECT id, shop_origin, started_at, finished_at, status, products_seen, products_new
                         FROM crawl_runs
                         ORDER BY started_at DESC
                         LIMIT 200`
                    )
                    .all();

                const runsByShop = new Map<string, RunRow[]>();
                for (const r of recentRuns) {
                    const arr = runsByShop.get(r.shop_origin) ?? [];
                    if (arr.length < 7) {
                        arr.push(r);
                        runsByShop.set(r.shop_origin, arr);
                    }
                }

                const rows: CoverageRow[] = shops.map((s) => ({
                    shop_origin: s.origin,
                    display_name: s.display_name,
                    enabled: 1,
                    cap_live: s.cap_live as 0 | 1,
                    cap_history: s.cap_history as 0 | 1,
                    cap_listing: s.cap_listing as 0 | 1,
                    cap_ean: s.cap_ean as 0 | 1,
                    cap_search: s.cap_search as 0 | 1,
                    bot_protection: s.bot_protection as CoverageRow["bot_protection"],
                    product_count: s.product_count,
                    last_crawl_at: s.last_crawl_at,
                    recent_runs: (runsByShop.get(s.origin) ?? []).map((r) => ({
                        id: r.id,
                        started_at: r.started_at,
                        finished_at: r.finished_at,
                        status: r.status as CoverageRow["recent_runs"][0]["status"],
                        products_seen: r.products_seen,
                        products_new: r.products_new,
                    })),
                }));

                const totalProductsRow = db
                    .query<{ total: number }, []>(`SELECT COUNT(*) AS total FROM products WHERE is_active = 1`)
                    .get();
                const totalProducts = totalProductsRow?.total ?? 0;

                const todayOffersRow = db
                    .query<{ total: number }, []>(
                        `SELECT COUNT(*) AS total FROM prices WHERE substr(observed_at, 1, 10) = date('now')`
                    )
                    .get();
                const totalOffersToday = todayOffersRow?.total ?? 0;

                const lastCrawlRow = db
                    .query<{ last: string | null }, []>(`SELECT MAX(finished_at) AS last FROM crawl_runs`)
                    .get();

                const body: CoverageResponse = {
                    rows,
                    summary: {
                        total_products: totalProducts,
                        total_offers_today: totalOffersToday,
                        last_crawl_at: lastCrawlRow?.last ?? null,
                    },
                };

                log.debug({ shops: rows.length }, "api: coverage served");
                return Response.json(body);
            }),
        },
    },
});
