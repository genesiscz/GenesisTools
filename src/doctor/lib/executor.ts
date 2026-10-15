import { logger } from "@genesiscz/utils/logger";
import { appendHistory } from "./history";
import { metadataBlockers } from "./remove-action";
import type { Action, ActionResult, ExecutorContext, Finding } from "./types";

export interface ExecuteOpts {
    runId: string;
    dryRun: boolean;
    items: Array<{ finding: Finding; action: Action }>;
}

/** Shared by direct execution and both interactive Trash staging routes. */
function findingBlockers(finding: Finding): string[] {
    const blockers = metadataBlockers(finding);
    return finding.severity === "blocked"
        ? [finding.blacklistReason ?? "this finding must not be acted on", ...blockers]
        : blockers;
}

export function unblockedActions(items: ExecuteOpts["items"]): ExecuteOpts["items"] {
    return items.filter(({ finding, action }) => {
        const blockers = findingBlockers(finding);
        if (blockers.length === 0) {
            return true;
        }

        logger.warn({ findingId: finding.id, actionId: action.id, blockers }, "finding blocked: action refused");
        return false;
    });
}

export async function executeActions(opts: ExecuteOpts): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const ctx: ExecutorContext = { runId: opts.runId, dryRun: opts.dryRun };

    for (const { finding, action } of opts.items) {
        const result = await runOne(ctx, finding, action);
        results.push(result);
        await appendHistory(opts.runId, result);

        if (action.followUp) {
            const follow = action.followUp(result);

            if (follow) {
                for (const nextAction of follow) {
                    const followResult = await runOne(ctx, finding, nextAction);
                    results.push(followResult);
                    await appendHistory(opts.runId, followResult);
                }
            }
        }
    }

    return results;
}

export async function runOne(ctx: ExecutorContext, finding: Finding, action: Action): Promise<ActionResult> {
    const blockers = findingBlockers(finding);
    if (blockers.length > 0) {
        return {
            findingId: finding.id,
            actionId: action.id,
            status: "skipped",
            error: `blocked: ${blockers.join("; ")}`,
            metadata: { blocked: true, blockers },
        };
    }

    if (typeof action.execute !== "function") {
        return {
            findingId: finding.id,
            actionId: action.id,
            status: "failed",
            error: "this finding came from the analyzer cache and cannot run; re-run doctor with --fresh",
        };
    }

    if (ctx.dryRun) {
        return {
            findingId: finding.id,
            actionId: action.id,
            status: "skipped",
            actualReclaimedBytes: finding.reclaimableBytes,
            metadata: { dryRun: true },
        };
    }

    try {
        return await action.execute(ctx, finding);
    } catch (err) {
        logger.error({ findingId: finding.id, actionId: action.id, err }, "action failed");
        return {
            findingId: finding.id,
            actionId: action.id,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
