import logger from "@app/logger";
import { SITEMAP_STRATEGIES, type SitemapStrategy } from "../api/sitemap-strategies";
import type { ShopsDatabase } from "../db/ShopsDatabase";
import { walkSitemap } from "./sitemap-fetcher";

const log = logger.child({ component: "sitemap-sync" });

export interface SitemapSyncOptions {
    shopOrigin: string;
    db: ShopsDatabase;
    /** Cap on URLs collected from the sitemap (loose). */
    maxUrls?: number;
    signal?: AbortSignal;
    onProgress?: (event: SitemapSyncProgress) => void;
}

export interface SitemapSyncProgress {
    discovered: number;
    knownInDb: number;
    newUrls: number;
}

export interface SitemapSyncResult {
    shopOrigin: string;
    rootSitemap: string;
    discovered: number;
    knownInDb: number;
    newUrls: string[];
    /** Sample URLs (first 5) shown in CLI summary even when --print is off. */
    sampleNew: string[];
    durationMs: number;
}

export async function syncShopSitemap(opts: SitemapSyncOptions): Promise<SitemapSyncResult> {
    const strategy = SITEMAP_STRATEGIES[opts.shopOrigin];
    if (!strategy) {
        throw new Error(
            `No sitemap strategy registered for "${opts.shopOrigin}". Supported: ${Object.keys(SITEMAP_STRATEGIES).join(", ")}`
        );
    }

    const start = Date.now();
    const knownSlugs = await loadKnownSlugs(opts.db, strategy.shopOrigin);

    log.info(
        { shop: strategy.shopOrigin, root: strategy.rootSitemap, knownInDb: knownSlugs.size },
        "starting sitemap walk"
    );

    let discovered = 0;
    let known = 0;
    const newUrls: string[] = [];

    for await (const url of walkSitemap(strategy.rootSitemap, {
        signal: opts.signal,
        maxUrls: opts.maxUrls,
        childFilter: strategy.isProductChild,
        urlFilter: strategy.isProductLeaf,
    })) {
        discovered++;
        const slug = strategy.productSlug(url);
        if (slug !== null && knownSlugs.has(slug)) {
            known++;
        } else {
            newUrls.push(url);
        }

        if (discovered % 5_000 === 0) {
            opts.onProgress?.({ discovered, knownInDb: known, newUrls: newUrls.length });
        }
    }

    opts.onProgress?.({ discovered, knownInDb: known, newUrls: newUrls.length });

    return {
        shopOrigin: strategy.shopOrigin,
        rootSitemap: strategy.rootSitemap,
        discovered,
        knownInDb: known,
        newUrls,
        sampleNew: newUrls.slice(0, 5),
        durationMs: Date.now() - start,
    };
}

async function loadKnownSlugs(db: ShopsDatabase, shopOrigin: string): Promise<Set<string>> {
    const rows = await db
        .raw()
        .query<{ slug: string }, [string]>("SELECT slug FROM products WHERE shop_origin = ?")
        .all(shopOrigin);
    return new Set(rows.map((r) => r.slug));
}

/** Public re-export so the command can advertise supported shops in --help. */
export function listSitemapShops(): string[] {
    return Object.keys(SITEMAP_STRATEGIES);
}

export type { SitemapStrategy };
