import {
    appendEffortJournal,
    type EffortJournalRecord,
    effortJournalPath,
} from "@app/azure-devops/timelog-effort-journal";
import type { JsonPatchOperation } from "@app/azure-devops/types";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";

const REMAINING_FIELD = "Microsoft.VSTS.Scheduling.RemainingWork";
const COMPLETED_FIELD = "Microsoft.VSTS.Scheduling.CompletedWork";

export interface EffortResult {
    remaining: number;
    completed: number;
    remainingBefore: number;
    completedBefore: number;
}

export interface UpdateWorkItemEffortOpts {
    timeLogIds?: string[];
    journal?: boolean;
    journalPath?: string;
    /** Write these values instead of computing from loggedMinutes. */
    values?: { remaining: number; completed: number };
}

export type EffortApi = {
    getWorkItem(id: number): Promise<{ rawFields?: Record<string, unknown> }>;
    updateWorkItem(id: number, operations: JsonPatchOperation[]): Promise<unknown>;
};

/**
 * Apply signed minutes to Remaining / Completed.
 * Positive minutes decrement Remaining and increment Completed.
 * Negative minutes reverse that. Both fields floor at 0.
 */
export function computeEffortValues(
    currentRemaining: number | null | undefined,
    currentCompleted: number | null | undefined,
    loggedMinutes: number
): { remaining: number; completed: number } {
    const loggedHours = loggedMinutes / 60;

    return {
        remaining: Math.max(0, (currentRemaining ?? 0) - loggedHours),
        completed: Math.max(0, (currentCompleted ?? 0) + loggedHours),
    };
}

export async function readWorkItemEffort(
    api: EffortApi,
    workItemId: number
): Promise<{ remaining: number | null; completed: number | null } | null> {
    const workItem = await api.getWorkItem(workItemId);
    const fields = workItem.rawFields;

    if (!fields) {
        logger.debug(`[effort] Work item #${workItemId} has no rawFields, skipping effort update`);
        return null;
    }

    return {
        remaining: (fields[REMAINING_FIELD] as number | null | undefined) ?? null,
        completed: (fields[COMPLETED_FIELD] as number | null | undefined) ?? null,
    };
}

/**
 * After logging time (or reverting it), update Remaining Work and Completed Work.
 * `loggedMinutes` is signed: negative values undo a prior add.
 *
 * Returns the new values, or null if the update failed (non-fatal).
 */
export async function updateWorkItemEffort(
    api: EffortApi,
    workItemId: number,
    loggedMinutes: number,
    opts?: UpdateWorkItemEffortOpts
): Promise<EffortResult | null> {
    try {
        const current = await readWorkItemEffort(api, workItemId);

        if (!current) {
            return null;
        }

        const currentRemaining = current.remaining;
        const currentCompleted = current.completed;
        const next = opts?.values ?? computeEffortValues(currentRemaining, currentCompleted, loggedMinutes);
        const newRemaining = Math.max(0, next.remaining);
        const newCompleted = Math.max(0, next.completed);

        const operations: JsonPatchOperation[] = [
            {
                op: currentRemaining != null ? "replace" : "add",
                path: `/fields/${REMAINING_FIELD}`,
                value: newRemaining,
            },
            {
                op: currentCompleted != null ? "replace" : "add",
                path: `/fields/${COMPLETED_FIELD}`,
                value: newCompleted,
            },
        ];

        await api.updateWorkItem(workItemId, operations);

        logger.debug(
            `[effort] Updated #${workItemId}: Remaining ${currentRemaining ?? 0} → ${newRemaining}, Completed ${currentCompleted ?? 0} → ${newCompleted}`
        );

        const result: EffortResult = {
            remaining: newRemaining,
            completed: newCompleted,
            remainingBefore: currentRemaining ?? 0,
            completedBefore: currentCompleted ?? 0,
        };

        if (opts?.journal !== false) {
            const record: EffortJournalRecord = {
                ts: new Date().toISOString(),
                workItemId,
                timeLogIds: opts?.timeLogIds ?? [],
                minutes: loggedMinutes,
                remainingBefore: result.remainingBefore,
                completedBefore: result.completedBefore,
                remainingAfter: newRemaining,
                completedAfter: newCompleted,
            };

            try {
                await appendEffortJournal(record, opts?.journalPath ?? effortJournalPath());
            } catch (err) {
                logger.warn({ error: err, workItemId }, "[effort] Failed to append effort journal");
                out.warn(
                    pc.yellow(
                        `  ⚠ Effort fields updated for #${workItemId}, but the local journal was not written. A later delete may only restore Remaining/Completed approximately.`
                    )
                );
            }
        }

        return result;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[effort] Failed to update effort for #${workItemId}: ${msg}`);
        out.warn(pc.yellow(`  ⚠ Could not update Remaining/Completed Work for #${workItemId}: ${msg}`));
        return null;
    }
}
