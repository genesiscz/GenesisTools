import type { AlertCandidate, RefireContext, StoredAlert, WindowCycle, WindowRef } from "./types";

/**
 * A provider moves a window's reset by seconds between readings. Two resets this close are one cycle; the old
 * threshold notifier used the same 10 minutes.
 */
export const RESET_JITTER_MS = 10 * 60_000;

/** Two reset instants of one window cycle. A missing reset on either side keeps the cycle: nothing proves a reset. */
export function sameResetCycle(previous: string | null, next: string | null): boolean {
    if (previous === null || next === null) {
        return true;
    }

    const left = Date.parse(previous);
    const right = Date.parse(next);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return previous === next;
    }

    return Math.abs(left - right) <= RESET_JITTER_MS;
}

/**
 * Whether `next` belongs to a later reset cycle than `previous`. An alert stored with no reset time cannot be compared
 * by cycle, so a reset of its window seen after it fired starts the new cycle; a reset time that only appears does not.
 */
export function startsNewCycle(previous: StoredAlert, next: AlertCandidate, context: RefireContext): boolean {
    if (previous.cycle === null && context.resetSeenAt !== null) {
        return Date.parse(context.resetSeenAt) > Date.parse(previous.firedAt);
    }

    return !sameResetCycle(previous.cycle, next.cycle);
}

/** The default re-fire rule: a new cycle fires again, the same cycle only when the severity rose. */
export function refireOnNewCycleOrHigherSeverity(
    previous: StoredAlert,
    next: AlertCandidate,
    context: RefireContext
): boolean {
    return startsNewCycle(previous, next, context) || next.severity > previous.severity;
}

/** The key of a window's reset history. */
export function windowCycleKey(window: WindowRef): string {
    return `${window.provider}\u0000${window.accountId}\u0000${window.windowKey}`;
}

/**
 * A window's reset history after one reading. A reading with no reset time changes nothing; the first reset time
 * read is the start of the history, not a reset; a reset time of another cycle is a reset seen at `now`.
 */
export function advanceWindowCycle(
    tracked: WindowCycle | null,
    resetsAt: string | null,
    now: Date
): WindowCycle | null {
    if (resetsAt === null) {
        return tracked;
    }

    if (tracked === null) {
        return { resetsAt, resetSeenAt: null };
    }

    if (sameResetCycle(tracked.resetsAt, resetsAt)) {
        return { resetsAt, resetSeenAt: tracked.resetSeenAt };
    }

    return { resetsAt, resetSeenAt: now.toISOString() };
}

/** For a change recorded at an instant: each instant fires once. */
export function refireOnNewInstant(previous: StoredAlert, next: AlertCandidate): boolean {
    return previous.cycle !== next.cycle;
}
