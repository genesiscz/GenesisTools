import logger from "@app/logger";
import type { ShopApiClient } from "@app/shops/api/ShopApiClient";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { createBulkMatcher } from "@app/shops/lib/bulk-matcher";
import type { CrawlOptions, CrawlProgressEvent, CrawlResult, ShopCrawlerInterface } from "@app/shops/crawlers/ShopCrawler.types";

const PROGRESS_EVERY_N_PRODUCTS = 25;

/**
 * Bulk-crawl orchestrator. Walks the shop's catalog, persists each yielded
 * RawProduct in 'pending' state, then runs BulkMatcher.flush() at end-of-stream
 * to resolve master assignment.
 *
 * Status flow: running -> matching (after crawl loop) -> completed (after flush).
 * On failure / cancellation: 'failed' / 'cancelled', flush is skipped.
 */
export abstract class ShopCrawler implements ShopCrawlerInterface {
    abstract readonly strategy: string;
    readonly client: ShopApiClient;
    readonly db: ShopsDatabase;
    private readonly classLog = logger.child({ component: "ShopCrawler" });

    constructor(client: ShopApiClient, db: ShopsDatabase) {
        this.client = client;
        this.db = db;
    }

    async run(opts: CrawlOptions = {}, onProgress?: (event: CrawlProgressEvent) => void): Promise<CrawlResult> {
        const log = this.classLog.child({
            strategy: this.strategy,
            shop: this.client.shopOrigin,
        });

        const crawlRunId = await this.db.startCrawlRun({
            shopOrigin: this.client.shopOrigin,
            strategy: this.strategy,
            options: { categoryId: opts.categoryId, limit: opts.limit },
        });

        let productsSeen = 0;
        let productsNew = 0;
        let pricesRecorded = 0;
        let cancelled = false;

        const emitProgress = (category?: string): void => {
            const event: CrawlProgressEvent = {
                crawlRunId,
                category,
                productsSeen,
                productsNew,
                pricesRecorded,
            };
            onProgress?.(event);
        };

        try {
            const categories =
                opts.categoryId !== undefined ? [{ id: opts.categoryId }] : await this.client.listCategories();

            for (const category of categories) {
                if (opts.signal?.aborted) {
                    cancelled = true;
                    break;
                }

                log.info({ category: category.id }, "starting category");
                try {
                    for await (const raw of this.client.listCategory({
                        category: category.id,
                        signal: opts.signal,
                    })) {
                        if (opts.signal?.aborted) {
                            cancelled = true;
                            break;
                        }

                        const upsert = await this.db.upsertProductPending(raw);
                        productsSeen++;
                        if (upsert.isNew) {
                            productsNew++;
                        }

                        if (raw.currentPrice !== undefined) {
                            await this.db.recordPrice({
                                product_id: upsert.id,
                                observed_at: raw.observedAt.toISOString(),
                                current_price: raw.currentPrice,
                                original_price: raw.originalPrice ?? null,
                                in_stock: raw.inStock === undefined ? null : raw.inStock ? 1 : 0,
                                source: `crawl:${this.strategy}`,
                                raw_json: null,
                            });
                            pricesRecorded++;
                        }

                        await this.db.incrementCrawlCounters(crawlRunId, {
                            productsSeen: 1,
                            productsNew: upsert.isNew ? 1 : 0,
                            pricesRecorded: raw.currentPrice !== undefined ? 1 : 0,
                        });

                        if (productsSeen % PROGRESS_EVERY_N_PRODUCTS === 0) {
                            emitProgress(category.id);
                        }

                        if (opts.limit !== undefined && productsSeen >= opts.limit) {
                            return await this.finalize(
                                crawlRunId,
                                productsSeen,
                                productsNew,
                                pricesRecorded,
                                "completed"
                            );
                        }
                    }
                } catch (err) {
                    if ((err as Error).name === "AbortError" || opts.signal?.aborted) {
                        cancelled = true;
                        break;
                    }

                    throw err;
                }

                emitProgress(category.id);
            }

            emitProgress();
            return await this.finalize(
                crawlRunId,
                productsSeen,
                productsNew,
                pricesRecorded,
                cancelled ? "cancelled" : "completed"
            );
        } catch (err) {
            log.error({ err }, "crawl failed");
            const message = err instanceof Error ? err.message : String(err);
            await this.db.finishCrawlRun(crawlRunId, "failed", message);
            return {
                crawlRunId,
                productsSeen,
                productsNew,
                pricesRecorded,
                status: "failed",
                error: message,
            };
        }
    }

    private async finalize(
        crawlRunId: number,
        productsSeen: number,
        productsNew: number,
        pricesRecorded: number,
        status: "completed" | "cancelled"
    ): Promise<CrawlResult> {
        if (status === "cancelled") {
            await this.db.finishCrawlRun(crawlRunId, "cancelled");
            return { crawlRunId, productsSeen, productsNew, pricesRecorded, status: "cancelled" };
        }

        await this.db.finishCrawlRun(crawlRunId, "matching");

        const log = this.classLog.child({ strategy: this.strategy, shop: this.client.shopOrigin, crawlRunId });
        log.info("crawl loop complete; running BulkMatcher.flush");
        const stats = await createBulkMatcher(this.db).flush(crawlRunId);
        log.info(stats, "bulk match flush completed");

        return { crawlRunId, productsSeen, productsNew, pricesRecorded, status: "completed" };
    }
}
