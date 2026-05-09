import logger from "@app/logger";
import type { ShopApiClient } from "../api/ShopApiClient";
import type { RawProduct } from "../api/ShopApiClient.types";
import { ShopRegistry } from "../api/ShopRegistry";
import { initShopRegistry } from "../api/registry-init";
import { SITEMAP_STRATEGIES, type SitemapStrategy } from "../api/sitemap-strategies";
import type { ShopsDatabase } from "../db/ShopsDatabase";
import { createBulkMatcher } from "./bulk-matcher";
import type { HttpRequestSink } from "./http-sink";
import { walkSitemap } from "./sitemap-fetcher";

const log = logger.child({ component: "sitemap-crawl" });

interface ListByIdsClient extends ShopApiClient {
    listByIds(
        ids: string[],
        opts: { signal?: AbortSignal; concurrency?: number }
    ): AsyncIterable<RawProduct>;
}

function hasListByIds(client: ShopApiClient): client is ListByIdsClient {
    return typeof (client as { listByIds?: unknown }).listByIds === "function";
}

export interface SitemapCrawlOptions {
    shopOrigin: string;
    db: ShopsDatabase;
    /** Cap on total products fetched (loose). */
    limit?: number;
    /** Skip ids already in `products` table (default true). */
    onlyNew?: boolean;
    /** Concurrency hint for clients that fan out per-id calls (kosik). */
    concurrency?: number;
    sink?: HttpRequestSink;
    signal?: AbortSignal;
    onProgress?: (event: SitemapCrawlProgress) => void;
}

export interface SitemapCrawlProgress {
    phase: "discovery" | "ingest";
    discovered: number;
    enqueued: number;
    fetched: number;
    persisted: number;
    pricesRecorded: number;
}

export interface SitemapCrawlResult {
    crawlRunId: number;
    shopOrigin: string;
    discovered: number;
    enqueued: number;
    fetched: number;
    persisted: number;
    pricesRecorded: number;
    durationMs: number;
}

export async function crawlFromSitemap(opts: SitemapCrawlOptions): Promise<SitemapCrawlResult> {
    const strategy = SITEMAP_STRATEGIES[opts.shopOrigin];
    if (!strategy) {
        throw new Error(`No sitemap strategy registered for ${opts.shopOrigin}`);
    }

    initShopRegistry({ sink: opts.sink });
    const client = ShopRegistry.get().forShop(strategy.shopOrigin);
    if (!client) {
        throw new Error(`No registered client for ${strategy.shopOrigin}`);
    }

    if (!hasListByIds(client)) {
        throw new Error(
            `${strategy.shopOrigin} client does not implement listByIds(); add the method or use \`tools shops crawl\` for category-based ingestion`
        );
    }

    const start = Date.now();
    const onlyNew = opts.onlyNew !== false;
    const knownSlugs = onlyNew ? await loadKnownSlugs(opts.db, strategy.shopOrigin) : new Set<string>();

    log.info(
        { shop: strategy.shopOrigin, root: strategy.rootSitemap, onlyNew, knownInDb: knownSlugs.size },
        "starting sitemap-driven crawl"
    );

    const ids = await collectIds(strategy, knownSlugs, opts);
    const enqueued = ids.length;
    const crawlRunId = await opts.db.startCrawlRun({
        shopOrigin: strategy.shopOrigin,
        strategy: "sitemap",
        options: { limit: enqueued },
    });

    let fetched = 0;
    let persisted = 0;
    let pricesRecorded = 0;

    const emit = (): void => {
        opts.onProgress?.({
            phase: "ingest",
            discovered: enqueued,
            enqueued,
            fetched,
            persisted,
            pricesRecorded,
        });
    };

    try {
        for await (const raw of client.listByIds(ids, {
            signal: opts.signal,
            concurrency: opts.concurrency,
        })) {
            opts.signal?.throwIfAborted();
            fetched++;

            const upsert = await opts.db.upsertProductPending(raw);
            persisted++;

            if (raw.currentPrice !== undefined) {
                await opts.db.recordPrice({
                    product_id: upsert.id,
                    observed_at: raw.observedAt.toISOString(),
                    current_price: raw.currentPrice,
                    original_price: raw.originalPrice ?? null,
                    in_stock: raw.inStock === undefined ? null : raw.inStock ? 1 : 0,
                    source: "crawl:sitemap",
                    raw_json: null,
                });
                pricesRecorded++;
            }

            await opts.db.incrementCrawlCounters(crawlRunId, {
                productsSeen: 1,
                productsNew: upsert.isNew ? 1 : 0,
                pricesRecorded: raw.currentPrice !== undefined ? 1 : 0,
            });

            if (fetched % 50 === 0) {
                emit();
            }
        }

        emit();

        // Run the matcher so newly seeded products get matched against
        // existing masters where possible (Layer 1/2a now firing thanks to
        // the upsertProductPending unit-extraction fix).
        await opts.db.finishCrawlRun(crawlRunId, "matching");
        log.info({ crawlRunId, fetched, persisted }, "ingest done; running BulkMatcher.flush");
        await createBulkMatcher(opts.db).flush(crawlRunId);

        return {
            crawlRunId,
            shopOrigin: strategy.shopOrigin,
            discovered: enqueued,
            enqueued,
            fetched,
            persisted,
            pricesRecorded,
            durationMs: Date.now() - start,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, fetched, persisted }, "sitemap crawl failed");
        await opts.db.finishCrawlRun(
            crawlRunId,
            (err as Error).name === "AbortError" ? "cancelled" : "failed",
            message
        );
        throw err;
    }
}

async function collectIds(
    strategy: SitemapStrategy,
    knownSlugs: Set<string>,
    opts: SitemapCrawlOptions
): Promise<string[]> {
    const ids: string[] = [];
    let discovered = 0;
    for await (const url of walkSitemap(strategy.rootSitemap, {
        signal: opts.signal,
        childFilter: strategy.isProductChild,
        urlFilter: strategy.isProductLeaf,
    })) {
        discovered++;
        const slug = strategy.productSlug(url);
        if (slug !== null && knownSlugs.has(slug)) {
            continue;
        }

        const id = strategy.productId(url);
        if (id !== null) {
            ids.push(id);
        }

        if (discovered % 5_000 === 0) {
            opts.onProgress?.({
                phase: "discovery",
                discovered,
                enqueued: ids.length,
                fetched: 0,
                persisted: 0,
                pricesRecorded: 0,
            });
        }

        if (opts.limit !== undefined && ids.length >= opts.limit) {
            break;
        }
    }

    opts.onProgress?.({
        phase: "discovery",
        discovered,
        enqueued: ids.length,
        fetched: 0,
        persisted: 0,
        pricesRecorded: 0,
    });
    return ids;
}

async function loadKnownSlugs(db: ShopsDatabase, shopOrigin: string): Promise<Set<string>> {
    const rows = await db
        .raw()
        .query<{ slug: string }, [string]>("SELECT slug FROM products WHERE shop_origin = ?")
        .all(shopOrigin);
    return new Set(rows.map((r) => r.slug));
}
