import type { ShopApiClient } from "@app/shops/api/ShopApiClient";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

export interface CrawlOptions {
    /** Limit to one shop-side category id. Crawls all categories when undefined. */
    categoryId?: string;
    /** Stop after N products yielded (across all categories). */
    limit?: number;
    /** Skip products updated within this many milliseconds. */
    staleAfterMs?: number;
    /** Abort signal — propagates from CLI Ctrl+C. */
    signal?: AbortSignal;
}

export interface CrawlProgressEvent {
    crawlRunId: number;
    category?: string;
    productsSeen: number;
    productsNew: number;
    pricesRecorded: number;
}

export interface CrawlResult {
    crawlRunId: number;
    productsSeen: number;
    productsNew: number;
    pricesRecorded: number;
    status: "completed" | "matching" | "failed" | "cancelled";
    error?: string;
}

export interface ShopCrawlerInterface {
    readonly client: ShopApiClient;
    readonly db: ShopsDatabase;
    readonly strategy: string;

    run(opts: CrawlOptions, onProgress?: (e: CrawlProgressEvent) => void): Promise<CrawlResult>;
}
