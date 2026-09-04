import { buildAssignmentView } from "@app/clarity/lib/assignment-view";
import { type SerialisedAssignmentRow, serialiseAssignmentRow } from "@app/clarity/lib/assignments";
import { requireAdoTimeLogConfig } from "@app/clarity/ui/src/server/ado-config";
import { logger } from "@genesiscz/utils/logger";

export interface AssignmentViewResult {
    month: number;
    year: number;
    assigned: SerialisedAssignmentRow[];
    unassigned: SerialisedAssignmentRow[];
    /** Epoch millis the view was built. The UI shows the age and refreshes past MAX_AGE_MS. */
    builtAt: number;
    fromCache: boolean;
}

/**
 * The view costs a month of ADO timelog plus an ancestor walk per work item, which is several
 * seconds. Cache it per month so opening the mappings page twice does not pay for it twice.
 */
export const MAX_AGE_MS = 5 * 60 * 1000;

const cache = new Map<string, { builtAt: number; result: AssignmentViewResult }>();
// Bumped by every invalidation. A build that started before the bump is stale by the time it
// resolves, so it must not repopulate the cache it was already cleared from.
let epoch = 0;

export async function getAssignmentView({
    month,
    year,
    refresh = false,
}: {
    month: number;
    year: number;
    refresh?: boolean;
}): Promise<AssignmentViewResult> {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const startedAt = epoch;
    const hit = cache.get(key);

    if (hit) {
        if (!refresh && Date.now() - hit.builtAt < MAX_AGE_MS) {
            return { ...hit.result, fromCache: true };
        }

        cache.delete(key);
    }

    // buildAssignmentView reaches five different `process.exit(1)` paths in src/azure-devops when
    // any ADO field is missing, which would take the dev server down mid-request. This throws on
    // all of them; a file-exists check would only have caught the first.
    requireAdoTimeLogConfig();

    logger.debug(`[clarity-ui] building the assignment view for ${key} (refresh=${refresh})`);
    const view = await buildAssignmentView(key);
    const result: AssignmentViewResult = {
        month: view.month,
        year: view.year,
        assigned: view.assigned.map(serialiseAssignmentRow),
        unassigned: view.unassigned.map(serialiseAssignmentRow),
        builtAt: Date.now(),
        fromCache: false,
    };

    if (startedAt === epoch) {
        cache.set(key, { builtAt: result.builtAt, result });
    }

    return result;
}

/** Drop every cached view, so a write is visible on the next read. */
export function invalidateAssignmentView(): void {
    epoch++;
    cache.clear();
}
