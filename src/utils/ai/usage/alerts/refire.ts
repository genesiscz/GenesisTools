import type { AlertCandidate, StoredAlert } from "./types";

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

/** The default re-fire rule: a new cycle fires again, the same cycle only when the severity rose. */
export function refireOnNewCycleOrHigherSeverity(previous: StoredAlert, next: AlertCandidate): boolean {
    return !sameResetCycle(previous.cycle, next.cycle) || next.severity > previous.severity;
}

/** For a change recorded at an instant: each instant fires once. */
export function refireOnNewInstant(previous: StoredAlert, next: AlertCandidate): boolean {
    return previous.cycle !== next.cycle;
}
