import logger from "@app/logger";
import { runGetProduct } from "@app/shops/lib/get-product";
import { SafeJSON } from "@app/utils/json";
import { formatTable } from "@app/utils/table";
import clipboardy from "clipboardy";
import type { Command } from "commander";

interface GetOptions {
    json?: boolean;
    fullHistory?: boolean;
    cache?: boolean;
    save?: boolean;
    match?: boolean;
}

const log = logger.child({ component: "shops:get" });

export function registerGetCommand(program: Command): void {
    program
        .command("get <url>")
        .description("Ingest a product URL — pulls history + meta from Hlídač and persists locally")
        .option("--json", "Output JSON instead of a human summary")
        .option("--full-history", "Request full price history (default: 365 days)")
        .option("--no-cache", "Bypass local cache (no-op in Plan 01 — cache lands later)")
        .option("--save", "Also copy the JSON output to the clipboard")
        .option("--match", "Print a stub pointing at Plan 04 (matcher not implemented yet)")
        .action(async (url: string, opts: GetOptions) => {
            await runGet(url, opts);
        });
}

async function runGet(url: string, opts: GetOptions): Promise<void> {
    if (opts.cache === false) {
        log.debug("--no-cache passed; cache lands in a later plan, this flag is currently a no-op");
    }

    if (opts.fullHistory) {
        log.debug("--full-history: S3 returns full series by default; affects /v2/detail fallback only");
    }

    const { ingested, source } = await runGetProduct({ url });

    if (opts.match) {
        process.stdout.write("Matching: see Plan 04 — not yet implemented\n");
    }

    if (opts.json) {
        const text = SafeJSON.stringify(
            {
                source,
                product: ingested.product,
                masterProductId: ingested.product.master_product_id,
                pricesRecorded: ingested.pricesRecorded,
            },
            null,
            2
        );
        process.stdout.write(`${text}\n`);
        if (opts.save) {
            await clipboardy.write(text);
            process.stderr.write("Copied to clipboard.\n");
        }

        return;
    }

    const summary = formatTable(
        [
            ["url", url],
            ["shop", ingested.product.shop_origin],
            ["slug", ingested.product.slug],
            ["product_id", String(ingested.product.id)],
            ["master_product_id", String(ingested.product.master_product_id ?? "(none)")],
            ["match_method", ingested.product.match_method],
            ["prices_recorded", String(ingested.pricesRecorded)],
            ["source", source],
        ],
        ["field", "value"]
    );
    process.stdout.write(`${summary}\n`);

    if (opts.save) {
        await clipboardy.write(summary);
        process.stderr.write("Copied to clipboard.\n");
    }
}
