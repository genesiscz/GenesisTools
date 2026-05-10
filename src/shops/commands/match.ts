import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { formatSummary, runGoldenHarness } from "@app/shops/lib/golden-harness";
import {
    acceptCandidatePair,
    listPendingCandidates,
    rejectCandidatePair,
    rematchProduct,
    resolveProductId,
} from "@app/shops/lib/match-api";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";

export function registerMatchCommand(program: Command): void {
    const cmd = program.command("match").description("Re-match products and triage candidate pairs");

    cmd.command("review")
        .description("List pending gray-zone match candidates as JSON")
        .option("--json", "Output JSON (default)", true)
        .action(async () => {
            const pairs = await listPendingCandidates();
            console.log(SafeJSON.stringify(pairs, null, 2));
        });

    cmd.command("accept <a> <b>")
        .description("Accept a pair (merges masters); a/b are product URLs or ids")
        .action(async (a: string, b: string) => {
            const shopsDb = getShopsDatabase();
            const pa = await resolveProductId(shopsDb, a);
            const pb = await resolveProductId(shopsDb, b);
            await acceptCandidatePair({ shopsDb, productIdA: pa, productIdB: pb });
            console.log(`accepted pair ${pa}-${pb}`);
        });

    cmd.command("reject <a> <b>")
        .description("Reject a pair forever; a/b are product URLs or ids")
        .action(async (a: string, b: string) => {
            const shopsDb = getShopsDatabase();
            const pa = await resolveProductId(shopsDb, a);
            const pb = await resolveProductId(shopsDb, b);
            await rejectCandidatePair({ shopsDb, productIdA: pa, productIdB: pb });
            console.log(`rejected pair ${pa}-${pb}`);
        });

    cmd.command("rematch <input>")
        .description("Reset a product to pending (will re-match on next crawl flush)")
        .action(async (input: string) => {
            const shopsDb = getShopsDatabase();
            const id = await resolveProductId(shopsDb, input);
            await rematchProduct({ shopsDb, productId: id });
            console.log(`reset product ${id} to pending`);
        });

    cmd.command("verify")
        .description("Run the golden-pair harness and print F1/precision/recall summary")
        .option("--json", "Output JSON instead of human summary")
        .action(async (opts: { json?: boolean }) => {
            const summary = await runGoldenHarness();
            if (opts.json) {
                console.log(SafeJSON.stringify(summary, null, 2));
                return;
            }

            console.log(formatSummary(summary));
            if (summary.f1 < 0.95) {
                process.exitCode = 1;
            }
        });
}
