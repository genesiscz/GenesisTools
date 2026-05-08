import logger from "@app/logger";
import type { Command } from "commander";
import { initShopRegistry } from "../api/registry-init";
import { ShopRegistry } from "../api/ShopRegistry";
import { KauflandCrawler } from "../crawlers/KauflandCrawler";
import { KosikRestCrawler } from "../crawlers/KosikRestCrawler";
import { RohlikRestCrawler } from "../crawlers/RohlikRestCrawler";
import type { ShopCrawler } from "../crawlers/ShopCrawler";
import type { CrawlResult } from "../crawlers/ShopCrawler.types";
import { ShopsDatabase } from "../db/ShopsDatabase";

export interface RunCrawlInput {
    shop: string;
    category?: string;
    limit?: number;
    db: ShopsDatabase;
    signal?: AbortSignal;
    onProgress?: (line: string) => void;
}

export async function runCrawlCommand(input: RunCrawlInput): Promise<CrawlResult> {
    initShopRegistry();
    const client = ShopRegistry.get().forShop(input.shop);
    if (!client) {
        throw new Error(
            `unknown shop "${input.shop}". Try one of: rohlik.cz, kosik.cz, kaufland.cz`
        );
    }

    let crawler: ShopCrawler;
    switch (client.shopOrigin) {
        case "rohlik.cz":
            crawler = new RohlikRestCrawler(client, input.db);
            break;
        case "kosik.cz":
            crawler = new KosikRestCrawler(client, input.db);
            break;
        case "kaufland.cz":
            crawler = new KauflandCrawler(client, input.db);
            break;
        default:
            throw new Error(`no crawler registered for ${client.shopOrigin}`);
    }

    return crawler.run(
        { categoryId: input.category, limit: input.limit, signal: input.signal },
        (e) => {
            input.onProgress?.(
                `[${client.shopOrigin}] seen=${e.productsSeen} new=${e.productsNew} prices=${e.pricesRecorded}` +
                    (e.category ? ` cat=${e.category}` : "")
            );
        }
    );
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
