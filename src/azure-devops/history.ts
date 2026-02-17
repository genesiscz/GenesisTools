/**
 * Azure DevOps Work Item History Processing
 *
 * Utilities for extracting meaningful periods (assignment, state) from
 * work item update data, plus fuzzy user matching with Czech diacritics support.
 */

import type {
    AssignmentPeriod,
    IdentityRef,
    ReportingRevision,
    StatePeriod,
    WorkItemHistorySection,
    WorkItemUpdate,
} from "@app/azure-devops/types";
import { removeDiacritics } from "@app/utils/string";

/**
 * Normalize a user name for fuzzy matching.
 * Lowercases, removes parenthetical content (e.g. "(QK)"),
 * and replaces Czech/French/German diacritics with ASCII equivalents.
 */
export function normalizeUserName(name: string): string {
    let normalized = name
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
    if (normalizedName === normalizedQuery) return true;

    // Contains match
    if (normalizedName.includes(normalizedQuery)) return true;

    // Word-by-word match (handles reversed name order)
    const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryWords.length > 0) {
        const nameWords = normalizedName.split(/\s+/).filter(Boolean);
        const allQueryWordsFound = queryWords.every((qw) => nameWords.some((nw) => nw.includes(qw)));
        if (allQueryWordsFound) return true;
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
    if (exactDisplay) return exactDisplay;

    // Exact uniqueName match
    const exactUnique = members.find((m) => m.uniqueName?.toLowerCase() === query.toLowerCase());
    if (exactUnique) return exactUnique;

    // Fuzzy match via userMatches
    const fuzzyMatch = members.find((m) => userMatches(m.displayName, query));
    return fuzzyMatch ?? null;
}

/** Sentinel date used by Azure DevOps for the latest revision's revisedDate */
const SENTINEL_DATE_PREFIX = "9999";

/** Clamp sentinel dates (9999-01-01) to current time */
function sanitizeDate(date: string): string {
    return date.startsWith(SENTINEL_DATE_PREFIX) ? new Date().toISOString() : date;
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

    for (const update of sorted) {
        const assignedToChange = update.fields?.["System.AssignedTo"];
        if (!assignedToChange) continue;

        const newAssignee = (assignedToChange.newValue as IdentityRef)?.displayName ?? null;
        const changeDate = sanitizeDate(update.revisedDate);

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

    for (const update of sorted) {
        const stateChange = update.fields?.["System.State"];
        const assignedToChange = update.fields?.["System.AssignedTo"];

        // Track assignee regardless of state change
        if (assignedToChange) {
            currentAssignee = (assignedToChange.newValue as IdentityRef)?.displayName ?? null;
        }

        if (!stateChange) continue;

        const newState = stateChange.newValue as string | undefined;
        const changeDate = sanitizeDate(update.revisedDate);

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
export function buildWorkItemHistory(_workItemId: number, updates: WorkItemUpdate[]): WorkItemHistorySection {
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
export function buildHistoryFromRevisions(_workItemId: number, revisions: ReportingRevision[]): WorkItemHistorySection {
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
        if (period.durationMinutes == null) continue;

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
