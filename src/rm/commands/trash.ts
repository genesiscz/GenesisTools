import { toolCommand } from "@genesiscz/utils/cli";
import { createStopwatch, formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    type DrainProgress,
    drainDue,
    listBatches,
    measureBytes,
    restoreBatch,
    runDrainer,
    sweepOrphans,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { runContext } from "../lib/run";

function dueIn(drainAfter: string): string {
    const minutes = Math.ceil((Date.parse(drainAfter) - Date.now()) / 60_000);
    return minutes <= 0 ? "due now" : `in ${minutes} min`;
}

export function registerTrashCommands(program: Command): void {
    program
        .command("trash")
        .description("what waits in the trash for the background drain")
        .option("--sizes", "measure each batch (walks the moved folders)")
        .option("--json", "print as JSON")
        .action((flags: { sizes?: boolean; json?: boolean }) => {
            const batches = listBatches();
            const rows = batches.map((batch) => ({
                ...batch,
                bytes: flags.sizes ? batch.items.reduce((sum, item) => sum + measureBytes(item.stored), 0) : null,
            }));

            if (flags.json) {
                out.result(rows);
                return;
            }

            if (rows.length === 0) {
                out.println("The trash is empty.");
                return;
            }

            for (const batch of rows) {
                const size = batch.bytes === null ? "" : ` ${formatBytes(batch.bytes)}`;
                out.println(
                    `${pc.bold(batch.id)} ${batch.items.length} item(s)${size} ${pc.dim(`drain ${dueIn(batch.drainAfter)}`)}`
                );

                for (const item of batch.items) {
                    out.println(pc.dim(`  ${item.original}`));
                }
            }
        });

    program
        .command("restore")
        .description("move a batch (or some of its paths) back where it was")
        .argument("<batch>", `the batch id (${toolCommand("rm")} trash lists them)`)
        .argument("[paths...]", "only these original paths")
        .action((id: string, paths: string[]) => {
            const ctx = runContext();
            const result = restoreBatch(id, { config: ctx.config, only: paths, caller: ctx.caller });

            for (const path of result.restored) {
                out.println(pc.green(`restored ${path}`));
            }

            for (const skip of result.skipped) {
                out.println(pc.yellow(`kept in the trash ${skip.path}: ${skip.reason}`));
            }

            process.exitCode = result.skipped.length > 0 ? 1 : 0;
        });

    program
        .command("drain")
        .description("delete what waits in the trash: the due batches, or all with --now")
        .option("--now", "every batch, also those still in their grace period")
        .option(
            "--background",
            `run as the background drainer until the trash is empty (${toolCommand("rm")} starts it)`
        )
        .action(async (flags: { now?: boolean; background?: boolean }) => {
            const { config } = runContext();

            if (flags.background) {
                await runDrainer({ config });
                return;
            }

            const elapsed = createStopwatch();
            const onItem = (progress: DrainProgress) =>
                out.println(`  ${progress.path}  ${formatBytes(progress.bytes)}  ${pc.dim(progress.elapsed)}`);
            const swept = await sweepOrphans({ config, onItem });
            const drained = await drainDue({ config, force: flags.now, onItem });
            const left = listBatches().length;
            out.println(
                `Drained ${drained.batches + swept.batches} batch(es), ${formatBytes(drained.bytes + swept.bytes)} freed in ${elapsed()}.` +
                    (left > 0 ? pc.dim(` ${left} batch(es) still in their grace period (--now drains them).`) : "")
            );
        });
}
