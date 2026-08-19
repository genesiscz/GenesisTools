import { computeEffortValues } from "@app/azure-devops/timelog-effort";
import type { EffortJournalRecord } from "@app/azure-devops/timelog-effort-journal";

export type EffortRestoreReason =
    | "exact-journal"
    | "approximate-multi-id"
    | "approximate-drifted"
    | "approximate-no-journal";

export interface EffortRestorePlan {
    workItemId: number;
    minutes: number;
    remainingBefore: number;
    completedBefore: number;
    remainingAfter: number;
    completedAfter: number;
    reason: EffortRestoreReason;
    warning?: string;
}

const EPSILON = 1e-6;

export function effortNumbersEqual(a: number, b: number): boolean {
    return Math.abs(a - b) < EPSILON;
}

export function planEffortRestore(args: {
    workItemId: number;
    minutes: number;
    timeLogId: string;
    currentRemaining: number | null | undefined;
    currentCompleted: number | null | undefined;
    journal: EffortJournalRecord | null;
}): EffortRestorePlan {
    const remainingBefore = args.currentRemaining ?? 0;
    const completedBefore = args.currentCompleted ?? 0;
    const arithmetic = computeEffortValues(args.currentRemaining, args.currentCompleted, -args.minutes);

    if (!args.journal) {
        return {
            workItemId: args.workItemId,
            minutes: args.minutes,
            remainingBefore,
            completedBefore,
            remainingAfter: arithmetic.remaining,
            completedAfter: arithmetic.completed,
            reason: "approximate-no-journal",
            warning:
                "No effort journal record for this entry (created before journaling shipped). Restore is approximate: Remaining += hours, Completed -= hours, both floored at 0.",
        };
    }

    const coversOnlyThisId = args.journal.timeLogIds.length === 1 && args.journal.timeLogIds[0] === args.timeLogId;
    const fieldsMatchAfter =
        effortNumbersEqual(remainingBefore, args.journal.remainingAfter) &&
        effortNumbersEqual(completedBefore, args.journal.completedAfter);

    if (coversOnlyThisId && fieldsMatchAfter) {
        return {
            workItemId: args.workItemId,
            minutes: args.minutes,
            remainingBefore,
            completedBefore,
            remainingAfter: args.journal.remainingBefore,
            completedAfter: args.journal.completedBefore,
            reason: "exact-journal",
        };
    }

    if (!coversOnlyThisId) {
        return {
            workItemId: args.workItemId,
            minutes: args.minutes,
            remainingBefore,
            completedBefore,
            remainingAfter: arithmetic.remaining,
            completedAfter: arithmetic.completed,
            reason: "approximate-multi-id",
            warning: `Journal record covers ${args.journal.timeLogIds.length} entries; cannot restore the exact pre-import fields. Applying arithmetic for this entry only.`,
        };
    }

    return {
        workItemId: args.workItemId,
        minutes: args.minutes,
        remainingBefore,
        completedBefore,
        remainingAfter: arithmetic.remaining,
        completedAfter: arithmetic.completed,
        reason: "approximate-drifted",
        warning: `Work item fields have changed since the journalled update (Remaining ${args.journal.remainingAfter} → now ${remainingBefore}, Completed ${args.journal.completedAfter} → now ${completedBefore}). Restore is approximate.`,
    };
}
