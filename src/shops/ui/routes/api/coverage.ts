import { logger } from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { CoverageResponse, CoverageRow } from "@app/shops/types";
import { apiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "kysely";

const log = logger.child({ component: "api:coverage" });

export const Route = createFileRoute("/api/coverage")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const k = getShopsDatabase().kysely();

                const shops = await k
                    .selectFrom("shops as s")
                    .select((eb) => [
                        "s.origin",
                        "s.display_name",
                        "s.cap_live",
                        "s.cap_history",
                        "s.cap_listing",
                        "s.cap_ean",
                        "s.cap_search",
                        "s.bot_protection",
                        eb
                            .selectFrom("products as p")
                            .select((eb2) => eb2.fn.countAll<number>().as("c"))
                            .where("p.shop_origin", "=", eb.ref("s.origin"))
                            .where("p.is_active", "=", 1)
                            .as("product_count"),
                        eb
                            .selectFrom("crawl_runs as cr")
                            .select((eb2) => eb2.fn.max("cr.finished_at").as("m"))
                            .where("cr.shop_origin", "=", eb.ref("s.origin"))
                            .as("last_crawl_at"),
                    ])
                    .orderBy("s.display_name")
                    .execute();

                const recentRuns = await k
                    .selectFrom("crawl_runs")
                    .select([
                        "id",
                        "shop_origin",
                        "started_at",
                        "finished_at",
                        "status",
                        "products_seen",
                        "products_new",
                    ])
                    .orderBy("started_at", "desc")
                    .limit(200)
                    .execute();

                const runsByShop = new Map<string, (typeof recentRuns)[number][]>();
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

                const totalProducts =
                    (
                        await k
                            .selectFrom("products")
                            .select((eb) => eb.fn.countAll<number>().as("total"))
                            .where("is_active", "=", 1)
                            .executeTakeFirst()
                    )?.total ?? 0;

                const totalOffersToday =
                    (
                        await k
                            .selectFrom("prices")
                            .select((eb) => eb.fn.countAll<number>().as("total"))
                            .where(sql`substr(observed_at, 1, 10)`, "=", sql`date('now')`)
                            .executeTakeFirst()
                    )?.total ?? 0;

                const lastCrawlRow = await k
                    .selectFrom("crawl_runs")
                    .select((eb) => eb.fn.max("finished_at").as("last"))
                    .executeTakeFirst();

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
