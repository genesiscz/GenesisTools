import logger from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";

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

interface ShopRow {
    origin: string;
    display_name: string;
    enabled: number;
    cap_live: number;
    cap_history: number;
    cap_listing: number;
    cap_ean: number;
    cap_search: number;
    bot_protection: string;
}

interface CountRow {
    shop_origin: string;
    n: number;
    last_update: string | null;
}

interface CrawlRow {
    shop_origin: string;
    last_success: string | null;
    last_failure: string | null;
}

function crawlRunsTableExists(shopsDb: ShopsDatabase): boolean {
    const row = shopsDb
        .raw()
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='crawl_runs'")
        .get();
    return row !== null;
}

export async function getCoverage(ctx?: CoverageApiContext): Promise<ShopCoverage[]> {
    const shopsDb = ctx?.shopsDb ?? getShopsDatabase();
    const shops = shopsDb
        .raw()
        .query<ShopRow, []>(
            `SELECT origin, display_name, enabled, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection
             FROM shops ORDER BY origin`
        )
        .all();

    const counts = shopsDb
        .raw()
        .query<CountRow, []>(
            `SELECT shop_origin, COUNT(*) AS n, MAX(last_updated_at) AS last_update
             FROM products WHERE is_active = 1 GROUP BY shop_origin`
        )
        .all();
    const countByOrigin = new Map(counts.map((c) => [c.shop_origin, c]));

    const crawlByOrigin = new Map<string, CrawlRow>();
    if (crawlRunsTableExists(shopsDb)) {
        const rows = shopsDb
            .raw()
            .query<CrawlRow, []>(
                `SELECT shop_origin,
                        MAX(CASE WHEN status = 'completed' THEN finished_at END) AS last_success,
                        MAX(CASE WHEN status = 'failed'    THEN finished_at END) AS last_failure
                 FROM crawl_runs GROUP BY shop_origin`
            )
            .all();
        for (const r of rows) {
            crawlByOrigin.set(r.shop_origin, r);
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
