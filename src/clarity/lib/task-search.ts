export interface ClarityTaskSearchResult {
    taskId: number;
    code: string;
    name: string;
}

export interface ClarityTaskSearchHit extends ClarityTaskSearchResult {
    /** The search term that first found this task. */
    term: string;
    /** Whether the task is already a row on EVERY opened timesheet in scope, so `--add` is not needed. */
    onTimesheet: boolean;
    /** Start dates of the weeks in scope that already carry the task. */
    onWeeks: string[];
}

/** Which opened weeks in scope already carry each task. */
export interface TimesheetMembership {
    /** How many opened timesheets are in scope. */
    weeks: number;
    /** Task id to the start dates of the weeks that carry it. */
    byTask: Map<number, string[]>;
}

/**
 * The name prefixes a search term stands for. Clarity names a delivery task `D_<adoId>_…` and a
 * standing one `<adoId>_…`, so an Azure DevOps id alone searches both. Both keep the trailing
 * `_`, or `410001` would also find the task of work item `4100019`.
 */
export function searchPrefixes(term: string): string[] {
    const trimmed = term.trim();

    if (/^\d+$/.test(trimmed)) {
        return [`D_${trimmed}_`, `${trimmed}_`];
    }

    return [trimmed];
}

/** One row per task across every term, sorted by name; the first term that found it is kept. */
export function mergeSearchHits(
    groups: Array<{ term: string; results: ClarityTaskSearchResult[] }>,
    membership: TimesheetMembership
): ClarityTaskSearchHit[] {
    const byId = new Map<number, ClarityTaskSearchHit>();

    for (const group of groups) {
        for (const result of group.results) {
            if (!byId.has(result.taskId)) {
                const onWeeks = membership.byTask.get(result.taskId) ?? [];

                byId.set(result.taskId, {
                    ...result,
                    term: group.term,
                    onTimesheet: membership.weeks > 0 && onWeeks.length === membership.weeks,
                    onWeeks,
                });
            }
        }
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
