export interface ClarityTaskSearchResult {
    taskId: number;
    code: string;
    name: string;
}

export interface ClarityTaskSearchHit extends ClarityTaskSearchResult {
    /** The search term that first found this task. */
    term: string;
    /** Whether the task is already a row on a timesheet in scope, so `--add` is not needed. */
    onTimesheet: boolean;
}

/**
 * The name prefixes a search term stands for. Clarity names a delivery task `D_<adoId>_…` and a
 * standing one `<adoId>_…`, so an Azure DevOps id alone searches both.
 */
export function searchPrefixes(term: string): string[] {
    const trimmed = term.trim();

    if (/^\d+$/.test(trimmed)) {
        return [`D_${trimmed}`, `${trimmed}_`];
    }

    return [trimmed];
}

/** One row per task across every term, sorted by name; the first term that found it is kept. */
export function mergeSearchHits(
    groups: Array<{ term: string; results: ClarityTaskSearchResult[] }>,
    onTimesheet: Set<number>
): ClarityTaskSearchHit[] {
    const byId = new Map<number, ClarityTaskSearchHit>();

    for (const group of groups) {
        for (const result of group.results) {
            if (!byId.has(result.taskId)) {
                byId.set(result.taskId, { ...result, term: group.term, onTimesheet: onTimesheet.has(result.taskId) });
            }
        }
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
