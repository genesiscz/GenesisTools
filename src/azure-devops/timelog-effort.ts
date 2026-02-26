import type { Api } from "@app/azure-devops/api";
import type { JsonPatchOperation } from "@app/azure-devops/types";
import logger from "@app/logger";
import pc from "picocolors";

const REMAINING_FIELD = "Microsoft.VSTS.Scheduling.RemainingWork";
const COMPLETED_FIELD = "Microsoft.VSTS.Scheduling.CompletedWork";

interface EffortResult {
    remaining: number;
    completed: number;
}

/**
 * After logging time, update the work item's Remaining Work and Completed Work fields.
 * Remaining is decremented, Completed is incremented by the logged hours.
 *
 * Returns the new values, or null if the update failed (non-fatal).
 */
export async function updateWorkItemEffort(
    api: Api,
    workItemId: number,
    loggedMinutes: number,
): Promise<EffortResult | null> {
    try {
        const loggedHours = loggedMinutes / 60;
        const workItem = await api.getWorkItem(workItemId);
        const fields = workItem.rawFields;

        if (!fields) {
            logger.debug(`[effort] Work item #${workItemId} has no rawFields, skipping effort update`);
            return null;
        }

        const currentRemaining = fields[REMAINING_FIELD] as number | null | undefined;
        const currentCompleted = fields[COMPLETED_FIELD] as number | null | undefined;

        const newCompleted = (currentCompleted ?? 0) + loggedHours;
        const newRemaining = Math.max(0, (currentRemaining ?? 0) - loggedHours);

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
            `[effort] Updated #${workItemId}: Remaining ${currentRemaining ?? 0} → ${newRemaining}, Completed ${currentCompleted ?? 0} → ${newCompleted}`,
        );

        return { remaining: newRemaining, completed: newCompleted };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[effort] Failed to update effort for #${workItemId}: ${msg}`);
        console.warn(pc.yellow(`  ⚠ Could not update Remaining/Completed Work for #${workItemId}: ${msg}`));
        return null;
    }
}
