import { logger } from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { sql } from "kysely";

const log = logger.child({ component: "shops:coverage-api" });

export interface CoverageApiContext {
    shopsDb?: ShopsDatabase;
}

export interface ShopCoverage {
    shop_origin: string;
    display_name: string;
    enabled: boolean;
    capabilities: {
        live: boolean;
        history: boolean;
        listing: boolean;
        ean: boolean;
        search: boolean;
    };
    bot_protection: string;
    product_count: number;
    last_product_update: string | null;
    last_crawl_success: string | null;
    last_crawl_failure: string | null;
}

function crawlRunsTableExists(shopsDb: ShopsDatabase): boolean {
    // sqlite_master is a SQLite-internal catalog table — not in ShopsDB. Stays raw.
    const row = shopsDb
        .raw()
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='crawl_runs'")
        .get();
    return row !== null;
}

export async function getCoverage(ctx?: CoverageApiContext): Promise<ShopCoverage[]> {
    const shopsDb = ctx?.shopsDb ?? getShopsDatabase();

    const shops = await shopsDb
        .kysely()
        .selectFrom("shops")
        .select([
            "origin",
            "display_name",
            "enabled",
            "cap_live",
            "cap_history",
            "cap_listing",
            "cap_ean",
            "cap_search",
            "bot_protection",
        ])
        .orderBy("origin")
        .execute();

    const counts = await shopsDb
        .kysely()
        .selectFrom("products")
        .select((eb) => [
            "shop_origin",
            eb.fn.countAll<number>().as("n"),
            eb.fn.max<string | null>("last_updated_at").as("last_update"),
        ])
        .where("is_active", "=", 1)
        .groupBy("shop_origin")
        .execute();
    const countByOrigin = new Map(counts.map((c) => [c.shop_origin, c]));

    const crawlByOrigin = new Map<string, { last_success: string | null; last_failure: string | null }>();
    if (crawlRunsTableExists(shopsDb)) {
        const rows = await shopsDb
            .kysely()
            .selectFrom("crawl_runs")
            .select([
                "shop_origin",
                sql<string | null>`MAX(CASE WHEN status = 'completed' THEN finished_at END)`.as("last_success"),
                sql<string | null>`MAX(CASE WHEN status = 'failed' THEN finished_at END)`.as("last_failure"),
            ])
            .groupBy("shop_origin")
            .execute();
        for (const r of rows) {
            crawlByOrigin.set(r.shop_origin, { last_success: r.last_success, last_failure: r.last_failure });
        }
    }

    const out = shops.map((s) => ({
        shop_origin: s.origin,
        display_name: s.display_name,
        enabled: s.enabled === 1,
        capabilities: {
            live: s.cap_live === 1,
            history: s.cap_history === 1,
            listing: s.cap_listing === 1,
            ean: s.cap_ean === 1,
            search: s.cap_search === 1,
        },
        bot_protection: s.bot_protection,
        product_count: countByOrigin.get(s.origin)?.n ?? 0,
        last_product_update: countByOrigin.get(s.origin)?.last_update ?? null,
        last_crawl_success: crawlByOrigin.get(s.origin)?.last_success ?? null,
        last_crawl_failure: crawlByOrigin.get(s.origin)?.last_failure ?? null,
    }));
    log.debug({ shops: out.length }, "getCoverage done");
    return out;
}
