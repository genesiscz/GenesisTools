import { toolCommand } from "@genesiscz/utils/cli";
import { createStopwatch, formatBytes, formatCount } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import {
    type DrainFailure,
    type DrainProgress,
    drainDue,
    listBatches,
    loadRmRequest,
    measureBytes,
    type RmCaller,
    recoverAsideJournals,
    requestBatchIds,
    restoreBatch,
    runDrainer,
    sweepOrphans,
    type TrashBatch,
} from "@genesiscz/utils/rm";
import type { Command } from "commander";
import pc from "picocolors";
import { isApprovedBatch } from "../lib/approve";
import { notifyDrainFailure } from "../lib/notify";
import { runContext } from "../lib/run";
import { renderTrash, resolveBatchSuffix } from "../lib/trash-view";

/**
 * The batches `id` names: a batch id as given, or every batch the approvals of request `id` made that is still in
 * the trash, oldest first (the window prints the request id before the batch exists). With none left, the newest
 * one, so the restore says why.
 */
function restoreTargets(id: string): string[] | { ambiguous: string[] } {
    const ids = listBatches().map((batch) => batch.id);
    const inTrash = new Set(ids);

    if (inTrash.has(id)) {
        return [id];
    }

    const request = loadRmRequest(id);

    if (!request) {
        // A tail of a batch id as `tools rm trash` prints it (`fc7b`); an ambiguous one names no batch.
        const match = resolveBatchSuffix(id, ids);

        if (match && "ambiguous" in match) {
            return match;
        }

        return [match?.id ?? id];
    }

    const made = requestBatchIds(request);
    const left = made.filter((batchId) => inTrash.has(batchId));
    return left.length > 0 ? left : [made.at(-1) ?? id];
}

/**
 * Whether an agent's `drain --now` may delete `batch` before its grace ends: only a batch this very session made, and
 * not one a person approved (that batch carries the asking session as its caller, and the grace the person picked).
 * Another session's batch and an approved one keep their restore window; a person drains them early.
 */
export function agentMayDrainEarly(batch: Pick<TrashBatch, "caller" | "items">, caller: RmCaller): boolean {
    return (
        caller.sessionId !== null &&
        batch.caller?.agent === caller.agent &&
        batch.caller?.sessionId === caller.sessionId &&
        !isApprovedBatch(batch)
    );
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
                bytes: flags.sizes
                    ? batch.items.reduce((sum, item) => sum + (item.bytes ?? measureBytes(item.stored)), 0)
                    : null,
            }));

            if (flags.json) {
                out.result(rows);
                return;
            }

            const measured = new Map(rows.flatMap((row) => (row.bytes === null ? [] : [[row.id, row.bytes] as const])));

            for (const line of renderTrash(batches, { now: new Date(), measured })) {
                out.println(line);
            }
        });

    program
        .command("restore")
        .description("move a batch (or some of its paths) back where it was")
        .argument(
            "<batch>",
            `the batch id or its tail as ${toolCommand("rm")} trash prints it (fc7b), or the id of the approved request`
        )
        .argument("[paths...]", "only these original paths")
        .action((id: string, paths: string[]) => {
            const ctx = runContext();
            const batchIds = restoreTargets(id);

            if (!Array.isArray(batchIds)) {
                out.println(
                    pc.red(`${id} matches ${batchIds.ambiguous.length} batches: ${batchIds.ambiguous.join(", ")}`)
                );
                out.println(pc.dim("Type more of the id, or the whole id."));
                process.exitCode = 1;
                return;
            }

            let skipped = 0;

            for (const batchId of batchIds) {
                if (batchIds.length > 1) {
                    out.println(pc.bold(`batch ${batchId}`));
                }

                const result = restoreBatch(batchId, { config: ctx.config, only: paths, caller: ctx.caller });

                for (const path of result.restored) {
                    out.println(pc.green(`restored ${path}`));
                }

                for (const skip of result.skipped) {
                    out.println(pc.yellow(`kept in the trash ${skip.path}: ${skip.reason}`));
                }

                for (const path of result.notMoved) {
                    out.println(pc.dim(`never moved, still in place ${path}`));
                }

                skipped += result.skipped.length;
            }

            process.exitCode = skipped > 0 ? 1 : 0;
        });

    program
        .command("drain")
        .description("delete what waits in the trash: the due batches, or all with --now")
        .option("--now", "every batch, also those still in their grace period (a person's; an agent: only its own)")
        .option(
            "--background",
            `run as the background drainer until the trash is empty (${toolCommand("rm")} starts it)`
        )
        .action(async (flags: { now?: boolean; background?: boolean }) => {
            const { config, caller } = runContext();
            // Every rm run starts this drainer: an aside run that died before it opened its request gets it here.
            recoverAsideJournals();

            // A failure is told once; the inbox post is awaited before the process may end.
            const told: Array<Promise<void>> = [];
            const onFailure = (failure: DrainFailure) => told.push(notifyDrainFailure(failure, config));

            if (flags.background) {
                await runDrainer({ config, onFailure });
                await Promise.all(told);
                return;
            }

            const elapsed = createStopwatch();
            const onItem = (progress: DrainProgress) =>
                out.println(`  ${progress.path}  ${formatBytes(progress.bytes)}  ${pc.dim(progress.elapsed)}`);
            // An agent's --now ends the grace of its own batches only: the rest stay restorable for their owner.
            const agentOnly = flags.now === true && caller.isInAgent;
            const forceOnly = agentOnly ? (batch: TrashBatch) => agentMayDrainEarly(batch, caller) : undefined;
            const swept = await sweepOrphans({ config, onItem });
            const drained = await drainDue({ config, force: flags.now, forceOnly, onItem, onFailure });
            await Promise.all(told);
            const left = listBatches().filter((batch) => !batch.incomplete).length;

            for (const entry of swept.held) {
                out.println(pc.yellow(`kept ${entry.id}: ${entry.reason}`));
            }

            for (const entry of swept.finished) {
                out.println(
                    pc.yellow(
                        `finished ${entry.id}, a batch whose run stopped: ${formatCount(entry.moved.length, "moved item")} ${entry.moved.length === 1 ? "drains" : "drain"} after the grace, ${formatCount(entry.notMoved.length, "path")} never moved and ${entry.notMoved.length === 1 ? "stays" : "stay"} in place`
                    )
                );
            }

            const leftNote = agentOnly
                ? ` ${formatCount(left, "batch", "batches")} of other sessions or approved by the user keep their grace period (only the user drains them early).`
                : ` ${formatCount(left, "batch", "batches")} still in their grace period (--now drains them).`;
            out.println(
                `Drained ${formatCount(drained.batches + swept.batches, "batch", "batches")}, ${formatBytes(drained.bytes + swept.bytes)} freed in ${elapsed()}.` +
                    (left > 0 ? pc.dim(leftNote) : "")
            );
        });
}
