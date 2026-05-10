import logger from "@app/logger";
import type { Command } from "commander";
import { initShopRegistry } from "@app/shops/api/registry-init";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import type { CrawlResult } from "@app/shops/crawlers/ShopCrawler.types";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { createCrawlerForShop } from "@app/shops/lib/crawler-factory";
import { DbHttpRequestSink, type HttpRequestSink } from "@app/shops/lib/http-sink";

export interface RunCrawlInput {
    shop: string;
    category?: string;
    limit?: number;
    db: ShopsDatabase;
    sink?: HttpRequestSink;
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
}

export async function runCrawlCommand(input: RunCrawlInput): Promise<CrawlResult> {
    initShopRegistry({ sink: input.sink });
    const client = ShopRegistry.get().forShop(input.shop);
    if (!client) {
        throw new Error(`unknown shop "${input.shop}". Try one of: rohlik.cz, kosik.cz, kaufland.cz`);
    }

    const crawler = createCrawlerForShop(client, input.db);

    return crawler.run({ categoryId: input.category, limit: input.limit, signal: input.signal }, (e) => {
        input.onProgress?.(
            `[${client.shopOrigin}] seen=${e.productsSeen} new=${e.productsNew} prices=${e.pricesRecorded}` +
                (e.category ? ` cat=${e.category}` : "")
        );
    });
}

export function registerCrawlCommand(program: Command): void {
    program
        .command("crawl")
        .description("Crawl a shop's catalog into the local DB")
        .requiredOption("--shop <shop>", "Shop origin (e.g. rohlik.cz)")
        .option("--category <id>", "Restrict to one shop-side category id")
        .option("--limit <n>", "Stop after N products", (v) => Number.parseInt(v, 10))
        .action(async (raw: { shop: string; category?: string; limit?: number }) => {
            const log = logger.child({ component: "shops:crawl" });
            const db = new ShopsDatabase();
            const sink = new DbHttpRequestSink(db);
            const ctrl = new AbortController();
            const onSig = (): void => {
                log.warn("SIGINT received, cancelling crawl");
                ctrl.abort();
            };
            process.once("SIGINT", onSig);
            try {
                const result = await runCrawlCommand({
                    shop: raw.shop,
                    category: raw.category,
                    limit: raw.limit,
                    db,
                    sink,
                    signal: ctrl.signal,
                    onProgress: (line) => process.stdout.write(`${line}\n`),
                });
                process.stdout.write(
                    `Crawl ${result.status}: seen=${result.productsSeen} new=${result.productsNew} prices=${result.pricesRecorded}\n`
                );
                if (result.status === "failed") {
                    process.exitCode = 1;
                }
            } finally {
                process.off("SIGINT", onSig);
                db.close();
            }
        });
}
