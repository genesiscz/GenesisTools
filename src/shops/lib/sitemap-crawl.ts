import logger from "@app/logger";
import { HlidacShopuClient } from "@app/shops/api/HlidacShopuClient";
import { initShopRegistry } from "@app/shops/api/registry-init";
import type { ShopApiClient } from "@app/shops/api/ShopApiClient";
import type { RawProduct } from "@app/shops/api/ShopApiClient.types";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { SITEMAP_STRATEGIES, type SitemapStrategy } from "@app/shops/api/sitemap-strategies";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { createBulkMatcher } from "@app/shops/lib/bulk-matcher";
import type { HttpRequestSink } from "@app/shops/lib/http-sink";
import { walkSitemap } from "@app/shops/lib/sitemap-fetcher";

const log = logger.child({ component: "sitemap-crawl" });

interface ListByIdsClient extends ShopApiClient {
    listByIds(ids: string[], opts: { signal?: AbortSignal; concurrency?: number }): AsyncIterable<RawProduct>;
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
    /** Disable the post-ingest hlidacshopu price-history backfill (default: enabled). */
    noHlidac?: boolean;
    /** Re-fetch hlidac history even for products that already have a 'hlidac:s3' row. */
    hlidacForce?: boolean;
    /** Concurrency for hlidac S3 fetches (default 10). */
    hlidacConcurrency?: number;
    /**
     * Skip the entire shop-API ingest path (no sitemap walk, no per-id
     * product fetch) and ONLY run the hlidac drain over every active
     * product currently in the DB for this shop. Use this to backfill
     * historical price points without re-hitting the shop's own API.
     */
    hlidacOnly?: boolean;
    sink?: HttpRequestSink;
    signal?: AbortSignal;
    onProgress?: (event: SitemapCrawlProgress) => void;
}

export interface SitemapCrawlProgress {
    phase: "discovery" | "ingest" | "hlidac";
    discovered: number;
    enqueued: number;
    fetched: number;
    persisted: number;
    pricesRecorded: number;
    hlidacBackfilled?: number;
    hlidacPointsAdded?: number;
}

export interface SitemapCrawlResult {
    crawlRunId: number;
    shopOrigin: string;
    discovered: number;
    enqueued: number;
    fetched: number;
    persisted: number;
    pricesRecorded: number;
    hlidacBackfilled: number;
    hlidacPointsAdded: number;
    durationMs: number;
}

export async function crawlFromSitemap(opts: SitemapCrawlOptions): Promise<SitemapCrawlResult> {
    const strategy = SITEMAP_STRATEGIES[opts.shopOrigin];
    if (!strategy) {
        throw new Error(`No sitemap strategy registered for ${opts.shopOrigin}`);
    }

    if (opts.hlidacOnly === true) {
        return crawlHlidacOnly(opts);
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
    let hlidacBackfilled = 0;
    let hlidacPointsAdded = 0;
    const hlidacQueue: Array<{ productId: number; url: string }> = [];

    const emit = (phase: SitemapCrawlProgress["phase"] = "ingest"): void => {
        opts.onProgress?.({
            phase,
            discovered: enqueued,
            enqueued,
            fetched,
            persisted,
            pricesRecorded,
            hlidacBackfilled,
            hlidacPointsAdded,
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

            if (!opts.noHlidac) {
                hlidacQueue.push({ productId: upsert.id, url: raw.url });
            }

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

        if (!opts.noHlidac && hlidacQueue.length > 0) {
            const drained = await drainHlidacQueue(opts.db, hlidacQueue, {
                concurrency: opts.hlidacConcurrency ?? 10,
                force: opts.hlidacForce ?? false,
                signal: opts.signal,
                onProgress: (n, points) => {
                    hlidacBackfilled = n;
                    hlidacPointsAdded = points;
                    emit("hlidac");
                },
            });
            hlidacBackfilled = drained.fetched;
            hlidacPointsAdded = drained.pointsAdded;
            log.info(
                { crawlRunId, hlidacBackfilled, hlidacPointsAdded, hlidacSkipped: drained.skipped },
                "hlidac price-history backfill complete"
            );
        }

        return {
            crawlRunId,
            shopOrigin: strategy.shopOrigin,
            discovered: enqueued,
            enqueued,
            fetched,
            persisted,
            pricesRecorded,
            hlidacBackfilled,
            hlidacPointsAdded,
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

async function crawlHlidacOnly(opts: SitemapCrawlOptions): Promise<SitemapCrawlResult> {
    const start = Date.now();
    const products = opts.db
        .raw()
        .query<{ id: number; url: string }, [string]>(
            "SELECT id, url FROM products WHERE shop_origin = ? AND is_active = 1 AND url IS NOT NULL ORDER BY id" +
                (opts.limit ? ` LIMIT ${Math.max(1, opts.limit)}` : "")
        )
        .all(opts.shopOrigin);
    log.info(
        { shop: opts.shopOrigin, products: products.length, force: opts.hlidacForce ?? false },
        "hlidac-only mode: skipping shop API, draining hlidac S3 only"
    );

    const crawlRunId = await opts.db.startCrawlRun({
        shopOrigin: opts.shopOrigin,
        strategy: "hlidac-only",
        options: { limit: products.length },
    });

    const queue = products.map((p) => ({ productId: p.id, url: p.url }));
    let backfilled = 0;
    let pointsAdded = 0;
    try {
        const drained = await drainHlidacQueue(opts.db, queue, {
            concurrency: opts.hlidacConcurrency ?? 10,
            force: opts.hlidacForce ?? false,
            signal: opts.signal,
            onProgress: (n, points) => {
                backfilled = n;
                pointsAdded = points;
                opts.onProgress?.({
                    phase: "hlidac",
                    discovered: products.length,
                    enqueued: products.length,
                    fetched: 0,
                    persisted: 0,
                    pricesRecorded: 0,
                    hlidacBackfilled: n,
                    hlidacPointsAdded: points,
                });
            },
        });
        backfilled = drained.fetched;
        pointsAdded = drained.pointsAdded;
        log.info(
            { crawlRunId, backfilled, pointsAdded, skipped: drained.skipped, errors: drained.errors },
            "hlidac-only drain complete"
        );
        await opts.db.finishCrawlRun(crawlRunId, "completed");
    } catch (err) {
        await opts.db.finishCrawlRun(
            crawlRunId,
            (err as Error).name === "AbortError" ? "cancelled" : "failed",
            (err as Error).message
        );
        throw err;
    }

    return {
        crawlRunId,
        shopOrigin: opts.shopOrigin,
        discovered: products.length,
        enqueued: products.length,
        fetched: 0,
        persisted: 0,
        pricesRecorded: 0,
        hlidacBackfilled: backfilled,
        hlidacPointsAdded: pointsAdded,
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

interface DrainResult {
    fetched: number;
    pointsAdded: number;
    skipped: number;
    errors: number;
}

interface DrainOpts {
    concurrency: number;
    force: boolean;
    signal?: AbortSignal;
    onProgress?: (fetched: number, points: number) => void;
}

/**
 * Drain a queue of {productId, url} through the hlidacshopu.cz S3 mirror,
 * inserting historical price points into the local `prices` table.
 *
 * Skips a product when at least one `source='hlidac:s3'` row is already
 * present, unless `force=true`. The `prices` PK on (product_id,
 * observed_at) makes the per-row INSERT idempotent.
 */
async function drainHlidacQueue(
    db: ShopsDatabase,
    queue: Array<{ productId: number; url: string }>,
    drainOpts: DrainOpts
): Promise<DrainResult> {
    const raw = db.raw();
    const hl = new HlidacShopuClient();
    const hasHistory = raw.query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM prices WHERE product_id = ? AND source = 'hlidac:s3'"
    );
    const insert = raw.prepare(
        "INSERT OR IGNORE INTO prices (product_id, observed_at, current_price, original_price, in_stock, source, raw_json) VALUES (?, ?, ?, ?, NULL, 'hlidac:s3', NULL)"
    );

    let fetched = 0;
    let pointsAdded = 0;
    let skipped = 0;
    let errors = 0;

    const work = [...queue];
    const workers = Array.from({ length: Math.max(1, drainOpts.concurrency) }, async () => {
        while (work.length > 0) {
            drainOpts.signal?.throwIfAborted();
            const item = work.shift();
            if (!item) {
                break;
            }

            if (!drainOpts.force) {
                const existing = hasHistory.get(item.productId);
                if (existing && existing.n > 0) {
                    skipped++;
                    continue;
                }
            }

            try {
                const r = await hl.getByUrl(item.url);
                const entries = r.history?.entries;
                if (!entries || entries.length === 0) {
                    fetched++;
                    continue;
                }

                fetched++;
                const tx = raw.transaction((rows: Array<{ d: string; c: number | null; o: number | null }>) => {
                    let added = 0;
                    for (const e of rows) {
                        if (!e.d) {
                            continue;
                        }

                        const observedAt = `${e.d}T00:00:00Z`;
                        const result = insert.run(item.productId, observedAt, e.c, e.o);
                        if (result.changes > 0) {
                            added++;
                        }
                    }

                    return added;
                });
                pointsAdded += tx(entries);
            } catch (err) {
                errors++;
                if (errors <= 5) {
                    log.warn({ err, productId: item.productId, url: item.url }, "hlidac history fetch failed");
                }
            }

            if ((fetched + skipped) % 100 === 0) {
                drainOpts.onProgress?.(fetched, pointsAdded);
            }
        }
    });
    await Promise.all(workers);
    drainOpts.onProgress?.(fetched, pointsAdded);
    return { fetched, pointsAdded, skipped, errors };
}
