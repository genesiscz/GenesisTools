import type { LimitKind, LimitWindow } from "@genesiscz/utils/ai/providers/account-features";

export type UsageColor = "red" | "yellow" | "green";

export function colorForPercent(pct: number): UsageColor {
    if (pct >= 80) {
        return "red";
    }

    if (pct >= 50) {
        return "yellow";
    }

    return "green";
}

/**
 * How close a reset has to be before a spent window stops reading as a problem.
 * A session window refilling in 20 minutes is not worth a red bar; a weekly one
 * refilling tonight is not either.
 */
export const DEFAULT_IMMINENT_RESET_MS: Record<LimitKind, number> = {
    session: 30 * 60 * 1000,
    weekly: 6 * 60 * 60 * 1000,
    scoped: 6 * 60 * 60 * 1000,
    monthly: 24 * 60 * 60 * 1000,
    credit: 24 * 60 * 60 * 1000,
};

export function isResetImminent(
    window: LimitWindow,
    now: number,
    thresholds: Partial<Record<LimitKind, number>> = {}
): boolean {
    if (!window.resetsAt) {
        return false;
    }

    const resetMs = Date.parse(window.resetsAt);

    if (!Number.isFinite(resetMs)) {
        return false;
    }

    const remaining = resetMs - now;

    if (remaining <= 0) {
        // Already rolled over — the cache just has not caught up.
        return true;
    }

    return remaining <= (thresholds[window.kind] ?? DEFAULT_IMMINENT_RESET_MS[window.kind]);
}

/** Percent colour that accounts for the refill: low-but-about-to-reset reads green. */
export function colorForWindow(
    window: LimitWindow,
    now: number,
    thresholds?: Partial<Record<LimitKind, number>>
): UsageColor {
    if (isResetImminent(window, now, thresholds)) {
        return "green";
    }

    return colorForPercent(window.percentUsed);
}
