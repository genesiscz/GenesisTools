import type { LimitWindow } from "@genesiscz/utils/ai/providers/account-features";

/**
 * `6d 15h 57m` until a window resets, `resets now` once the cache is behind the
 * rollover, null when the window has no reset at all.
 */
export function formatResetCountdown(resetsAt: string | null | undefined, now: number = Date.now()): string | null {
    if (!resetsAt) {
        return null;
    }

    const resetTime = new Date(resetsAt).getTime();

    if (!Number.isFinite(resetTime)) {
        return null;
    }

    const remainingMs = resetTime - now;

    if (remainingMs <= 0) {
        return "resets now";
    }

    const totalMinutes = Math.floor(remainingMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];

    if (days > 0) {
        parts.push(`${days}d`);
    }

    if (hours > 0) {
        parts.push(`${hours}h`);
    }

    if (minutes > 0 || parts.length === 0) {
        parts.push(`${minutes}m`);
    }

    return parts.join(" ");
}

/**
 * The text after a window's percent: `⟳ 4d 9h 27m` while it counts down, `not used`
 * for a window nothing touched (0% and no reset, which is how every provider adapter
 * reports an idle window), nothing when a spent window carries no reset time.
 */
export function windowTail(window: Pick<LimitWindow, "percentUsed" | "resetsAt">, now: number = Date.now()): string {
    if (!window.resetsAt && window.percentUsed === 0) {
        return "not used";
    }

    const countdown = formatResetCountdown(window.resetsAt, now);
    return countdown ? `⟳ ${countdown}` : "";
}
