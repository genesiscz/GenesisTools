import logger from "@app/logger";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { DbHttpRequestSink } from "@app/shops/lib/http-sink";
import { crawlFromSitemap } from "@app/shops/lib/sitemap-crawl";
import { listSitemapShops } from "@app/shops/lib/sitemap-sync";
import type { Command } from "commander";

interface SitemapCrawlCliOpts {
    shop: string;
    limit?: number;
    concurrency?: number;
    refresh?: boolean;
    noHlidac?: boolean;
    hlidacForce?: boolean;
    hlidacConcurrency?: number;
    hlidacOnly?: boolean;
}

export function registerSitemapCrawlCommand(program: Command): void {
    const supported = listSitemapShops();
    program
        .command("sitemap-crawl")
        .description(
            `Walk a shop's sitemap and ingest every discovered product into the local DB. Supported: ${supported.join(", ")}`
        )
        .requiredOption("--shop <shop>", `Shop origin (one of: ${supported.join(", ")})`)
        .option("--limit <n>", "Stop after fetching N products", (v) => Number.parseInt(v, 10))
        .option("--concurrency <n>", "Per-id fan-out for clients without bulk endpoints (kosik)", (v) =>
            Number.parseInt(v, 10)
        )
        .option("--refresh", "Re-fetch products already in the DB (default: skip them and only ingest new ids)")
        .option("--no-hlidac", "Skip the post-ingest hlidacshopu.cz price-history backfill")
        .option("--hlidac-force", "Re-fetch hlidac history even for products that already have it stored")
        .option("--hlidac-concurrency <n>", "Parallel hlidac S3 fetches (default 10)", (v) => Number.parseInt(v, 10))
        .option("--hlidac-only", "Skip the shop API entirely; just drain hlidac history for products already in the DB")
        .action(async (raw: SitemapCrawlCliOpts) => {
            const log = logger.child({ component: "shops:sitemap-crawl" });
            const db = new ShopsDatabase();
            const sink = new DbHttpRequestSink(db);
            const ctrl = new AbortController();
            const onSig = (): void => {
                log.warn("SIGINT received, cancelling sitemap crawl");
                ctrl.abort();
            };
            process.once("SIGINT", onSig);
            try {
                const result = await crawlFromSitemap({
                    shopOrigin: raw.shop,
                    db,
                    sink,
                    limit: raw.limit,
                    concurrency: raw.concurrency,
                    onlyNew: raw.refresh !== true,
                    noHlidac: raw.noHlidac === true,
                    hlidacForce: raw.hlidacForce === true,
                    hlidacConcurrency: raw.hlidacConcurrency,
                    hlidacOnly: raw.hlidacOnly === true,
                    signal: ctrl.signal,
                    onProgress: (p) => {
                        let line: string;
                        if (p.phase === "discovery") {
                            line = `[${raw.shop}] discovery: scanned=${p.discovered} queued=${p.enqueued}\n`;
                        } else if (p.phase === "hlidac") {
                            line = `[${raw.shop}] hlidac: backfilled=${p.hlidacBackfilled ?? 0} points=${p.hlidacPointsAdded ?? 0}\n`;
                        } else {
                            line = `[${raw.shop}] ingest: fetched=${p.fetched} persisted=${p.persisted} prices=${p.pricesRecorded} (of ${p.enqueued})\n`;
                        }

                        process.stdout.write(line);
                    },
                });
                process.stdout.write(
                    `✓ ${result.shopOrigin}: discovered=${result.discovered} fetched=${result.fetched} persisted=${result.persisted} prices=${result.pricesRecorded} hlidac=${result.hlidacBackfilled}(${result.hlidacPointsAdded}pts) (${(result.durationMs / 1000).toFixed(1)}s)\n`
                );
            } catch (err) {
                process.stderr.write(`× sitemap-crawl failed: ${(err as Error).message}\n`);
                process.exitCode = 1;
            } finally {
                process.off("SIGINT", onSig);
                db.close();
            }
        });
}
