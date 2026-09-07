/**
 * The bucket vocabulary itself lives in the anthropic-sub plugin (`buckets.ts`), because
 * the usage mapper that produces `LimitWindow[]` is inside `src/utils/**` and may not
 * import `@app/*`. This file keeps the claude TUI's own presentation: Ink colours, the
 * percent thresholds and the reset-imminence rule.
 */
export {
    BUCKET_KIND_MAP,
    BUCKET_LABELS,
    BUCKET_PERIODS_MS,
    bucketKind,
    VISIBLE_BUCKETS,
} from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/buckets";

export const BUCKET_THRESHOLD_MAP: Record<string, "session" | "weekly"> = {
    five_hour: "session",
    seven_day: "weekly",
    seven_day_opus: "weekly",
    seven_day_sonnet: "weekly",
    seven_day_oauth_apps: "weekly",
};

export const BUCKET_COLORS: Record<string, string> = {
    five_hour: "\x1b[36m", // cyan
    seven_day: "\x1b[33m", // yellow
    seven_day_opus: "\x1b[35m", // magenta
    seven_day_sonnet: "\x1b[32m", // green
    seven_day_oauth_apps: "\x1b[34m", // blue
};

export const BUCKET_INK_COLORS: Record<string, string> = {
    five_hour: "cyan",
    seven_day: "yellow",
    seven_day_opus: "magenta",
    seven_day_sonnet: "green",
    seven_day_oauth_apps: "blue",
};

export const POLL_INTERVALS = [5, 10, 15, 30, 60] as const;
export type PollInterval = (typeof POLL_INTERVALS)[number];

export function colorForPct(pct: number): "red" | "yellow" | "green" {
    if (pct >= 80) {
        return "red";
    }

    if (pct >= 50) {
        return "yellow";
    }

    return "green";
}

/**
 * How close a reset has to be before a spent bucket stops reading as a problem.
 * A 5h window refilling in 20 minutes is not worth a red bar; a weekly one
 * refilling tonight isn't either.
 */
const IMMINENT_RESET_MS: Record<"session" | "weekly", number> = {
    session: 30 * 60 * 1000,
    weekly: 6 * 60 * 60 * 1000,
};

/** Whether a bucket's reset is close enough that being spent no longer matters. */
export function isResetImminent(bucket: string, resetsAt: string | null, now: Date = new Date()): boolean {
    if (!resetsAt) {
        return false;
    }

    const resetMs = new Date(resetsAt).getTime();

    if (!Number.isFinite(resetMs)) {
        return false;
    }

    const remaining = resetMs - now.getTime();

    if (remaining <= 0) {
        // Already rolled over — the cache just hasn't caught up.
        return true;
    }

    return remaining <= IMMINENT_RESET_MS[BUCKET_THRESHOLD_MAP[bucket] ?? "weekly"];
}

/**
 * Utilization color that accounts for the refill: low-but-about-to-reset reads
 * green instead of red, which is what "resets now" rows should look like.
 */
export function colorForPctWithReset(
    pct: number,
    bucket: string,
    resetsAt: string | null,
    now: Date = new Date()
): "red" | "yellow" | "green" {
    if (isResetImminent(bucket, resetsAt, now)) {
        return "green";
    }

    return colorForPct(pct);
}
