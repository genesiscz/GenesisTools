import type { LifecycleStatus } from "./types";

export interface LifecycleInput {
    isCandidate: boolean;
    /** ISO timestamp of the existing mark, or null if never marked. */
    firstMarked: string | null;
    /** Injected current time in epoch ms — the core never reads the clock. */
    now: number;
    graceMs: number;
}

/**
 * PURE. Maps (candidacy, existing mark, injected now) to a lifecycle status.
 * Callers act on the result: "dying" with no mark -> record now; "rescued" ->
 * delete the mark; "dead" -> keep mark, report ready-to-die; "alive" -> ensure
 * no mark.
 */
export function evaluateLifecycle(input: LifecycleInput): LifecycleStatus {
    const { isCandidate, firstMarked, now, graceMs } = input;

    if (!isCandidate) {
        return firstMarked ? "rescued" : "alive";
    }

    if (!firstMarked) {
        return "dying";
    }

    const elapsed = now - Date.parse(firstMarked);
    if (elapsed >= graceMs) {
        return "dead";
    }

    return "dying";
}
