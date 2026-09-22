/**
 * Azure DevOps Work Item History Processing
 *
 * Utilities for extracting meaningful periods (assignment, state) from
 * work item update data, plus fuzzy user matching with Czech diacritics support.
 */

import { isSentinelDate, resolveUpdateDate } from "@app/azure-devops/lib/activity-days";
import type {
    AssignmentPeriod,
    IdentityRef,
    ReportingRevision,
    StatePeriod,
    WorkItemHistorySection,
    WorkItemUpdate,
} from "@app/azure-devops/types";
import { removeDiacritics } from "@genesiscz/utils/string";

/**
 * Normalize a user name for fuzzy matching.
 * Lowercases, removes parenthetical content (e.g. "(QK)"),
 * and replaces Czech/French/German diacritics with ASCII equivalents.
 */
export function normalizeUserName(name: string): string {
    const normalized = name
        .toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, " ")
        .trim();
    return removeDiacritics(normalized);
}

/**
 * Fuzzy match a user name against a query string.
 * Supports exact match (after normalization), contains match,
 * and word-by-word match (handles reversed name order like "Doe John" matching "John Doe").
 */
export function userMatches(userName: string, query: string): boolean {
    const normalizedName = normalizeUserName(userName);
    const normalizedQuery = normalizeUserName(query);

    // Exact match
    if (normalizedName === normalizedQuery) {
        return true;
    }

    // Contains match
    if (normalizedName.includes(normalizedQuery)) {
        return true;
    }

    // Word-by-word match (handles reversed name order)
    const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryWords.length > 0) {
        const nameWords = normalizedName.split(/\s+/).filter(Boolean);
        const allQueryWordsFound = queryWords.every((qw) => nameWords.some((nw) => nw.includes(qw)));
        if (allQueryWordsFound) {
            return true;
        }
    }

    return false;
}

/**
 * Resolve a fuzzy user query to an exact team member identity.
 * Tries exact displayName, then exact uniqueName, then falls back to fuzzy matching.
 */
export function resolveUser(query: string, members: IdentityRef[]): IdentityRef | null {
    // Exact displayName match
    const exactDisplay = members.find((m) => m.displayName.toLowerCase() === query.toLowerCase());
    if (exactDisplay) {
        return exactDisplay;
    }

    // Exact uniqueName match
    const exactUnique = members.find((m) => m.uniqueName?.toLowerCase() === query.toLowerCase());
    if (exactUnique) {
        return exactUnique;
    }

    // Fuzzy match via userMatches
    const fuzzyMatch = members.find((m) => userMatches(m.displayName, query));
    return fuzzyMatch ?? null;
}

/** Clamp sentinel dates (9999-01-01) to current time */
function sanitizeDate(date: string): string {
    return isSentinelDate(date) ? new Date().toISOString() : date;
}

/**
 * When the update was made: its changed date, never `revisedDate`, which is when the NEXT
 * revision replaced it. Empty when no real date can be recovered.
 *
 * 🛑 The old `|| update.revisedDate` defeated the sentinel handling it was meant to complete.
 * `resolveUpdateDate` already tries both field dates and a non-sentinel `revisedDate`, so it
 * returns `""` only when every candidate is absent or is the `9999-01-01` sentinel. Falling
 * back to `revisedDate` there handed the sentinel to `sanitizeDate`, which turned it into the
 * CURRENT time: a two-year-old undated revision was reported as having happened today, and it
 * then matched every date window instead of being excluded from all of them.
 */
function updateMoment(update: WorkItemUpdate): string {
    return resolveUpdateDate(update);
}

/**
 * When each update happened, in rev order. An update whose moment cannot be recovered borrows
 * the next dated moment, or the last dated one when nothing dated follows it; only a history with
 * no dated update at all is left empty.
 *
 * 🛑 Skipping an undated update, the first fix for the today-dated boundary, dropped its
 * TRANSITION as well as its date: a middle one vanished and its time went to the state before
 * it, and a trailing one left the item reported in a state it had already left. Borrowing a
 * neighbour's moment keeps every transition, invents no time, and never dates anything today.
 */
function momentsOf(sorted: WorkItemUpdate[]): string[] {
    const moments = sorted.map(updateMoment);
    let next = "";

    for (let index = moments.length - 1; index >= 0; index -= 1) {
        if (moments[index]) {
            next = moments[index] as string;
        } else {
            moments[index] = next;
        }
    }

    let previous = "";

    for (let index = 0; index < moments.length; index += 1) {
        if (moments[index]) {
            previous = moments[index] as string;
        } else {
            moments[index] = previous;
        }
    }

    return moments;
}

function computeDurationMinutes(start: string, end: string): number {
    return Math.round((new Date(sanitizeDate(end)).getTime() - new Date(sanitizeDate(start)).getTime()) / 60000);
}

/**
 * Compute assignment periods from work item updates.
 * Tracks System.AssignedTo field changes and builds contiguous periods
 * where each person was assigned.
 */
export function computeAssignmentPeriods(updates: WorkItemUpdate[]): AssignmentPeriod[] {
    const sorted = [...updates].sort((a, b) => a.rev - b.rev);
    const periods: AssignmentPeriod[] = [];

    let currentAssignee: string | null = null;
    let periodStart: string | null = null;
    const moments = momentsOf(sorted);

    for (const [index, update] of sorted.entries()) {
        const assignedToChange = update.fields?.["System.AssignedTo"];
        if (!assignedToChange) {
            continue;
        }

        const newAssignee = (assignedToChange.newValue as IdentityRef)?.displayName ?? null;
        const changeDate = moments[index];

        // Empty only when no update in the whole history carries a moment.
        if (!changeDate) {
            continue;
        }

        // Close previous period
        if (currentAssignee && periodStart) {
            periods.push({
                assignee: currentAssignee,
                assigneeNormalized: normalizeUserName(currentAssignee),
                startDate: periodStart,
                endDate: changeDate,
                durationMinutes: computeDurationMinutes(periodStart, changeDate),
            });
        }

        currentAssignee = newAssignee;
        periodStart = newAssignee ? changeDate : null;
    }

    // Final open period (still assigned)
    if (currentAssignee && periodStart) {
        periods.push({
            assignee: currentAssignee,
            assigneeNormalized: normalizeUserName(currentAssignee),
            startDate: periodStart,
            endDate: null,
            durationMinutes: null,
        });
    }

    return periods;
}

/**
 * Compute state periods from work item updates.
 * Tracks System.State changes and the current assignee during each state period.
 */
export function computeStatePeriods(updates: WorkItemUpdate[]): StatePeriod[] {
    const sorted = [...updates].sort((a, b) => a.rev - b.rev);
    const periods: StatePeriod[] = [];

    let currentState: string | null = null;
    let currentAssignee: string | null = null;
    let periodStart: string | null = null;
    const moments = momentsOf(sorted);

    for (const [index, update] of sorted.entries()) {
        const stateChange = update.fields?.["System.State"];
        const assignedToChange = update.fields?.["System.AssignedTo"];

        // Track assignee regardless of state change
        if (assignedToChange) {
            currentAssignee = (assignedToChange.newValue as IdentityRef)?.displayName ?? null;
        }

        if (!stateChange) {
            continue;
        }

        const newState = stateChange.newValue as string | undefined;
        const changeDate = moments[index];

        if (!changeDate) {
            continue;
        }

        // Close previous period
        if (currentState && periodStart) {
            periods.push({
                state: currentState,
                startDate: periodStart,
                endDate: changeDate,
                durationMinutes: computeDurationMinutes(periodStart, changeDate),
                assigneeDuring: currentAssignee ?? undefined,
            });
        }

        currentState = newState ?? null;
        periodStart = newState ? changeDate : null;
    }

    // Final open period (still in current state)
    if (currentState && periodStart) {
        periods.push({
            state: currentState,
            startDate: periodStart,
            endDate: null,
            durationMinutes: null,
            assigneeDuring: currentAssignee ?? undefined,
        });
    }

    return periods;
}

/**
 * Build a complete work item history from update records.
 * Computes both assignment and state periods from the raw updates.
 */
export function buildWorkItemHistory(updates: WorkItemUpdate[]): WorkItemHistorySection {
    return {
        updates,
        assignmentPeriods: computeAssignmentPeriods(updates),
        statePeriods: computeStatePeriods(updates),
    };
}

/**
 * Build work item history from reporting API revisions (full snapshots).
 *
 * @note Less precise than /updates (no oldValue/newValue), but works for time-in-state.
 * The reporting API returns full field snapshots per revision, so we compare
 * consecutive revisions to detect field changes.
 */
export function buildHistoryFromRevisions(revisions: ReportingRevision[]): WorkItemHistorySection {
    const sorted = [...revisions].sort((a, b) => a.rev - b.rev);
    const assignmentPeriods: AssignmentPeriod[] = [];
    const statePeriods: StatePeriod[] = [];

    let prevState: string | null = null;
    let prevAssignee: string | null = null;
    let stateStart: string | null = null;
    let assigneeStart: string | null = null;

    for (const revision of sorted) {
        const state = (revision.fields["System.State"] as string) ?? null;
        const assigneeField = revision.fields["System.AssignedTo"];
        const assignee =
            typeof assigneeField === "string" ? assigneeField : ((assigneeField as IdentityRef)?.displayName ?? null);
        const changedDate =
            (revision.fields["System.ChangedDate"] as string) ??
            (revision.fields["System.RevisedDate"] as string) ??
            "";

        // Detect state change
        if (state !== prevState) {
            if (prevState && stateStart && changedDate) {
                statePeriods.push({
                    state: prevState,
                    startDate: stateStart,
                    endDate: changedDate,
                    durationMinutes: computeDurationMinutes(stateStart, changedDate),
                    assigneeDuring: prevAssignee ?? undefined,
                });
            }
            prevState = state;
            stateStart = changedDate || null;
        }

        // Detect assignee change
        if (assignee !== prevAssignee) {
            if (prevAssignee && assigneeStart && changedDate) {
                assignmentPeriods.push({
                    assignee: prevAssignee,
                    assigneeNormalized: normalizeUserName(prevAssignee),
                    startDate: assigneeStart,
                    endDate: changedDate,
                    durationMinutes: computeDurationMinutes(assigneeStart, changedDate),
                });
            }
            prevAssignee = assignee;
            assigneeStart = assignee ? changedDate || null : null;
        }
    }

    // Final open periods
    if (prevState && stateStart) {
        statePeriods.push({
            state: prevState,
            startDate: stateStart,
            endDate: null,
            durationMinutes: null,
            assigneeDuring: prevAssignee ?? undefined,
        });
    }

    if (prevAssignee && assigneeStart) {
        assignmentPeriods.push({
            assignee: prevAssignee,
            assigneeNormalized: normalizeUserName(prevAssignee),
            startDate: assigneeStart,
            endDate: null,
            durationMinutes: null,
        });
    }

    return {
        updates: [],
        assignmentPeriods,
        statePeriods,
    };
}

/**
 * Calculate total time spent in each state, broken down by assignee.
 * Only considers closed periods (with endDate) for accurate totals.
 */
export function calculateTimeInState(
    history: WorkItemHistorySection
): Map<string, { totalMinutes: number; byAssignee: Map<string, number> }> {
    const result = new Map<string, { totalMinutes: number; byAssignee: Map<string, number> }>();

    for (const period of history.statePeriods) {
        if (period.durationMinutes == null) {
            continue;
        }

        let entry = result.get(period.state);
        if (!entry) {
            entry = { totalMinutes: 0, byAssignee: new Map() };
            result.set(period.state, entry);
        }

        entry.totalMinutes += period.durationMinutes;

        if (period.assigneeDuring) {
            const current = entry.byAssignee.get(period.assigneeDuring) ?? 0;
            entry.byAssignee.set(period.assigneeDuring, current + period.durationMinutes);
        }
    }

    return result;
}
