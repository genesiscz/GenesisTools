/**
 * Sprint backlog: WIQL construction, field mapping, ordering and totals.
 *
 * Pure logic only. The command layer fetches ids with `Api.runWiql()` and
 * fields with `Api.getWorkItemFields()`, then calls into here.
 */

import { escapeWiqlValue } from "@app/azure-devops/wiql-builder";

/** Field set requested for every sprint row. */
export const SPRINT_FIELDS = [
    "System.Id",
    "System.WorkItemType",
    "System.Title",
    "System.State",
    "System.AssignedTo",
    "System.ChangedDate",
    "System.IterationPath",
    "Microsoft.VSTS.Scheduling.CompletedWork",
    "Microsoft.VSTS.Scheduling.RemainingWork",
    "Microsoft.VSTS.Common.StackRank",
    "Microsoft.VSTS.Common.BacklogPriority",
];

/** Work item types that carry their own spendable effort. */
const EFFORT_BEARING_TYPE = "Task";

export interface SprintRow {
    id: number;
    type: string;
    title: string;
    state: string;
    assignedTo: string;
    completedWork: number;
    remainingWork: number;
    /** Backlog stack rank; null when the type carries no rank. */
    order: number | null;
    changedDate: string;
    iterationPath: string;
}

export interface SprintTotals {
    /** Rows counted (Tasks only). */
    taskCount: number;
    /** Rows present in the sprint, all types. */
    itemCount: number;
    completedWork: number;
    remainingWork: number;
}

/**
 * Build the sprint WIQL.
 *
 * Uses an explicit `[System.IterationPath]` equality predicate rather than
 * `@CurrentIteration`, which fails project-scoped with VS402612 and hides which
 * iteration the server chose even when it works.
 *
 * @param assignedTo - "@Me" (unquoted macro) or a display name / unique name.
 */
export function buildSprintWiql(options: { iterationPath: string; assignedTo?: string }): string {
    const clauses = [
        "[System.TeamProject] = @project",
        `[System.IterationPath] = '${escapeWiqlValue(options.iterationPath)}'`,
    ];

    if (options.assignedTo) {
        const assignee = options.assignedTo === "@Me" ? "@Me" : `'${escapeWiqlValue(options.assignedTo)}'`;
        clauses.push(`[System.AssignedTo] = ${assignee}`);
    }

    return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [System.Id]`;
}

/** Coerce an Azure numeric field to a number; absent or unparseable becomes 0. */
function toNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return 0;
}

/** Coerce a rank field; absent means "unranked", which is distinct from rank 0. */
function toRank(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return null;
}

function toDisplayName(value: unknown): string {
    if (value && typeof value === "object" && "displayName" in value) {
        const name = (value as { displayName?: unknown }).displayName;
        return typeof name === "string" ? name : "";
    }

    if (typeof value === "string") {
        return value;
    }

    return "";
}

function toStringField(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Map one raw Azure DevOps field bag to a sprint row. */
export function mapSprintRow(id: number, fields: Record<string, unknown>): SprintRow {
    return {
        id,
        type: toStringField(fields["System.WorkItemType"]),
        title: toStringField(fields["System.Title"]),
        state: toStringField(fields["System.State"]),
        assignedTo: toDisplayName(fields["System.AssignedTo"]),
        completedWork: toNumber(fields["Microsoft.VSTS.Scheduling.CompletedWork"]),
        remainingWork: toNumber(fields["Microsoft.VSTS.Scheduling.RemainingWork"]),
        order:
            toRank(fields["Microsoft.VSTS.Common.StackRank"]) ??
            toRank(fields["Microsoft.VSTS.Common.BacklogPriority"]),
        changedDate: toStringField(fields["System.ChangedDate"]),
        iterationPath: toStringField(fields["System.IterationPath"]),
    };
}

/**
 * Sort into Backlog stack-rank order: ranked rows ascending first, then
 * unranked rows by id ascending so the output is stable across runs.
 */
export function sortByBacklogOrder(rows: SprintRow[]): SprintRow[] {
    return [...rows].sort((a, b) => {
        if (a.order !== null && b.order !== null && a.order !== b.order) {
            return a.order - b.order;
        }

        if (a.order !== null && b.order === null) {
            return -1;
        }

        if (a.order === null && b.order !== null) {
            return 1;
        }

        return a.id - b.id;
    });
}

export function sortById(rows: SprintRow[]): SprintRow[] {
    return [...rows].sort((a, b) => a.id - b.id);
}

/**
 * Sum effort over Tasks only.
 *
 * A User Story and its child Task both sit in the sprint and both carry a
 * Remaining value, so summing every type double counts the same work.
 */
export function sumTaskEffort(rows: SprintRow[]): SprintTotals {
    const tasks = rows.filter((row) => row.type === EFFORT_BEARING_TYPE);
    return {
        taskCount: tasks.length,
        itemCount: rows.length,
        completedWork: tasks.reduce((sum, row) => sum + row.completedWork, 0),
        remainingWork: tasks.reduce((sum, row) => sum + row.remainingWork, 0),
    };
}
