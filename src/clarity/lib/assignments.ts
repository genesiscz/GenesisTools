import type { WorkItemNode } from "@app/azure-devops/lib/ancestors";
import type { ClarityMapping } from "@app/clarity/config";
import { getMappingForWorkItem } from "@app/clarity/config";
import { type ClarityRecommendation, recommendClarityTask } from "@app/clarity/lib/recommend";
import type { ClarityTask } from "@app/clarity/lib/types";

export interface AssignmentRow {
    workItemId: number;
    minutes: number;
    title?: string;
    type?: string;
    mapping?: ClarityMapping;
    recommendation?: ClarityRecommendation;
    /** The stored mapping points somewhere the ancestor tree does not. */
    drifted: boolean;
}

export interface AssignmentRows {
    assigned: AssignmentRow[];
    unassigned: AssignmentRow[];
}

export interface AssignmentPair {
    workItemId: number;
    task: ClarityTask;
    title?: string;
    type?: string;
}

/**
 * Split the month's work items into mapped and unmapped, attach the tree-based recommendation to
 * each, and mark stored mappings that disagree with it. Pure, so the CLI and the UI share it.
 */
export function buildAssignmentRows({
    minutesByWorkItem,
    mappings,
    chains,
    tasks,
}: {
    minutesByWorkItem: Map<number, number>;
    mappings: ClarityMapping[];
    chains: Map<number, WorkItemNode[]>;
    tasks: ClarityTask[];
}): AssignmentRows {
    const assigned: AssignmentRow[] = [];
    const unassigned: AssignmentRow[] = [];

    for (const [workItemId, minutes] of minutesByWorkItem) {
        const chain = chains.get(workItemId) ?? [];
        const mapping = getMappingForWorkItem(mappings, workItemId);
        const recommendation = recommendClarityTask({ chain, tasks });
        const row: AssignmentRow = {
            workItemId,
            minutes,
            title: chain[0]?.title,
            type: chain[0]?.type,
            mapping,
            recommendation,
            drifted: Boolean(mapping && recommendation && mapping.clarityTaskId !== recommendation.task.taskId),
        };

        (mapping ? assigned : unassigned).push(row);
    }

    const byHours = (a: AssignmentRow, b: AssignmentRow) => b.minutes - a.minutes || a.workItemId - b.workItemId;

    return { assigned: assigned.sort(byHours), unassigned: unassigned.sort(byHours) };
}

/** Add or replace mappings for the given pairs, leaving every other mapping untouched. */
export function applyAssignments({
    mappings,
    pairs,
}: {
    mappings: ClarityMapping[];
    pairs: AssignmentPair[];
}): ClarityMapping[] {
    const next = [...mappings];

    for (const pair of pairs) {
        const mapping: ClarityMapping = {
            clarityTaskId: pair.task.taskId,
            clarityTaskName: pair.task.taskName,
            clarityTaskCode: pair.task.taskCode,
            clarityInvestmentName: pair.task.investmentName,
            clarityInvestmentCode: pair.task.investmentCode,
            adoWorkItemId: pair.workItemId,
            adoWorkItemTitle: pair.title ?? String(pair.workItemId),
            adoWorkItemType: pair.type,
        };
        const existing = next.findIndex((m) => m.adoWorkItemId === pair.workItemId);

        if (existing >= 0) {
            next[existing] = mapping;
        } else {
            next.push(mapping);
        }
    }

    return next;
}

/** Remove the mappings for the given work items and report which ones were actually dropped. */
export function removeAssignments({ mappings, workItemIds }: { mappings: ClarityMapping[]; workItemIds: number[] }): {
    mappings: ClarityMapping[];
    removed: ClarityMapping[];
} {
    const doomed = new Set(workItemIds);

    return {
        mappings: mappings.filter((m) => !doomed.has(m.adoWorkItemId)),
        removed: mappings.filter((m) => doomed.has(m.adoWorkItemId)),
    };
}
