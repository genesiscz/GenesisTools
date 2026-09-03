import type { WorkItemNode } from "@app/azure-devops/lib/ancestors";
import type { ClarityTask } from "@app/clarity/lib/types";

export interface ClarityRecommendation {
    task: ClarityTask;
    matched: WorkItemNode;
}

/**
 * Index Clarity tasks by the ADO id embedded in their name. `D_271735_Technologický dluh 2026`
 * bills ADO 271735, `262042_Ceremonie` bills 262042. Names without an id (Incidenty_Opex,
 * Rozvoj_domény_MČ) cannot be recommended and are left out.
 */
export function clarityTasksByAdoId(tasks: ClarityTask[]): Map<number, ClarityTask> {
    const byId = new Map<number, ClarityTask>();

    const ambiguous = new Set<number>();

    for (const task of tasks) {
        // The boundary is non-alphanumeric, not merely non-digit: an investment code like
        // P100001 is six digits behind a letter and would otherwise read as ADO work item 100001.
        const match = task.taskName.match(/(?<![0-9A-Za-z])\d{6}(?![0-9A-Za-z])/);

        if (!match) {
            continue;
        }

        const id = Number.parseInt(match[0], 10);

        if (byId.has(id)) {
            ambiguous.add(id);
            continue;
        }

        byId.set(id, task);
    }

    // Two tasks naming the same work item cannot be told apart, and picking by catalogue order
    // would make the recommendation depend on response ordering. Recommend neither.
    for (const id of ambiguous) {
        byId.delete(id);
    }

    return byId;
}

/**
 * Recommend the Clarity task for a work item by walking its ancestor chain and taking the closest
 * level whose id names a task. Returns nothing when no level matches; the caller decides what a
 * miss means, because the fallbacks are project knowledge and do not belong here.
 */
export function recommendClarityTask({
    chain,
    tasks,
}: {
    chain: WorkItemNode[];
    tasks: ClarityTask[];
}): ClarityRecommendation | undefined {
    const byId = clarityTasksByAdoId(tasks);

    for (const node of chain) {
        const task = byId.get(node.id);

        if (task) {
            return { task, matched: node };
        }
    }

    return undefined;
}
