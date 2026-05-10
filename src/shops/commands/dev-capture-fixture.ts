import type { Command } from "commander";
import { initShopRegistry } from "@app/shops/api/registry-init";
import { runCaptureFixture } from "@app/shops/lib/capture-fixture";

interface DevCaptureFixtureRawOpts {
    shop: string;
    url: string;
    out: string;
    evaluate?: string;
}

export function registerDevCaptureFixtureCommand(program: Command): void {
    const dev = program.command("dev").description("developer-only utilities");
    dev.command("capture-fixture")
        .description("Record a fixture from a live shop URL into src/shops/api/shops/__fixtures__/<shop>/")
        .requiredOption("--shop <origin>", "shopOrigin from the registry (e.g. notino.cz, alza.cz)")
        .requiredOption("--url <url>", "absolute URL to capture")
        .option("--out <dir>", "fixtures root directory", "src/shops/api/shops/__fixtures__")
        .option("--evaluate <expr>", "for WebView shops, JS expression to evaluate (default per shop)")
        .action(async (raw: DevCaptureFixtureRawOpts) => {
            initShopRegistry();
            const result = await runCaptureFixture({
                shop: raw.shop,
                url: raw.url,
                fixturesDir: raw.out,
                evaluateExpr: raw.evaluate,
            });
            for (const p of result.writtenPaths) {
                process.stdout.write(`wrote: ${p}\n`);
            }
        });
}
