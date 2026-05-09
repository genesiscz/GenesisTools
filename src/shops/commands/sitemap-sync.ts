import logger from "@app/logger";
import type { Command } from "commander";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { listSitemapShops, syncShopSitemap, type SitemapSyncResult } from "../lib/sitemap-sync";

interface SitemapSyncCliOpts {
    shop?: string;
    all?: boolean;
    maxUrls?: number;
    print?: boolean;
}

export function registerSitemapSyncCommand(program: Command): void {
    const supported = listSitemapShops();
    program
        .command("sitemap-sync")
        .description(
            `Discover product URLs from a shop's public sitemap and diff against the local DB. Supported: ${supported.join(", ")}`
        )
        .option("--shop <shop>", `Single shop origin (one of: ${supported.join(", ")})`)
        .option("--all", "Sync all supported shops sequentially")
        .option("--max-urls <n>", "Stop each shop after N URLs (loose cap)", (v) => Number.parseInt(v, 10))
        .option("--print", "Print every new URL (not just the first 5 sample)")
        .action(async (raw: SitemapSyncCliOpts) => {
            const log = logger.child({ component: "shops:sitemap-sync" });

            const targets = resolveTargets(raw, supported);
            if (targets.length === 0) {
                process.stderr.write(
                    `error: pass --shop <shop> or --all (supported: ${supported.join(", ")})\n`
                );
                process.exitCode = 1;
                return;
            }

            const db = new ShopsDatabase();
            const ctrl = new AbortController();
            const onSig = (): void => {
                log.warn("SIGINT received, cancelling sitemap sync");
                ctrl.abort();
            };
            process.once("SIGINT", onSig);

            try {
                for (const shop of targets) {
                    process.stdout.write(`\n→ syncing ${shop}\n`);
                    const result = await syncShopSitemap({
                        shopOrigin: shop,
                        db,
                        maxUrls: raw.maxUrls,
                        signal: ctrl.signal,
                        onProgress: (p) =>
                            process.stdout.write(
                                `  [${shop}] discovered=${p.discovered} known=${p.knownInDb} new=${p.newUrls}\n`
                            ),
                    });
                    printSummary(result, raw.print === true);
                }
            } finally {
                process.off("SIGINT", onSig);
                db.close();
            }
        });
}

function resolveTargets(opts: SitemapSyncCliOpts, supported: string[]): string[] {
    if (opts.all === true) {
        return supported;
    }

    if (opts.shop) {
        return [opts.shop];
    }

    return [];
}

function printSummary(r: SitemapSyncResult, printAll: boolean): void {
    process.stdout.write(
        `✓ ${r.shopOrigin}: discovered=${r.discovered} known=${r.knownInDb} new=${r.newUrls.length} (${r.durationMs}ms)\n` +
            `  root=${r.rootSitemap}\n`
    );

    if (r.newUrls.length === 0) {
        return;
    }

    if (printAll) {
        for (const url of r.newUrls) {
            process.stdout.write(`  ${url}\n`);
        }

        return;
    }

    process.stdout.write(`  sample new (${r.sampleNew.length} of ${r.newUrls.length}):\n`);
    for (const url of r.sampleNew) {
        process.stdout.write(`    ${url}\n`);
    }
}
