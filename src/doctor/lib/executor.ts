import logger from "@app/logger";
import { appendHistory } from "./history";
import type { Action, ActionResult, ExecutorContext, Finding } from "./types";

export interface ExecuteOpts {
    runId: string;
    dryRun: boolean;
    items: Array<{ finding: Finding; action: Action }>;
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

async function runOne(ctx: ExecutorContext, finding: Finding, action: Action): Promise<ActionResult> {
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
