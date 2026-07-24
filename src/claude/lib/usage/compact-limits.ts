import type { UsageBucket, UsageResponse } from "./api";

export interface CompactLimit {
    /** 0–100, % of the bucket still LEFT (headroom). */
    leftPct: number;
    resetsAt: string | null;
}

/** The three numbers the picker shows: 5h session, weekly, Fable weekly. */
export interface CompactLimits {
    session?: CompactLimit;
    weekly?: CompactLimit;
    fable?: CompactLimit;
}

function fromUsed(percentUsed: number, resetsAt: string | null): CompactLimit {
    return { leftPct: Math.min(100, Math.max(0, 100 - percentUsed)), resetsAt };
}

/**
 * Headroom with a PASSED reset treated as a fresh bucket. A slightly stale cache
 * showing "0% left" whose window has already rolled over must read as available —
 * we know the reset moment, so compute it instead of rendering a false red.
 * A missing limit is unconstrained (100).
 */
export function effectiveLeftPct(limit: CompactLimit | undefined, now: Date = new Date()): number {
    if (!limit) {
        return 100;
    }

    if (limit.resetsAt) {
        const resetMs = new Date(limit.resetsAt).getTime();

        if (Number.isFinite(resetMs) && resetMs <= now.getTime()) {
            return 100;
        }
    }

    return limit.leftPct;
}

function fromBucket(bucket: UsageBucket | null | undefined): CompactLimit | undefined {
    if (!bucket || typeof bucket.utilization !== "number") {
        return undefined;
    }

    return fromUsed(bucket.utilization, bucket.resets_at);
}

/**
 * Extract the compact 5h / weekly / Fable limits from a usage payload.
 * Prefers the modern `limits[]` array (the only place the Fable-scoped
 * weekly limit lives); falls back to the legacy flat buckets.
 */
export function extractCompactLimits(usage: UsageResponse): CompactLimits {
    const compact: CompactLimits = {};

    if (Array.isArray(usage.limits)) {
        for (const raw of usage.limits) {
            if (typeof raw?.percent !== "number") {
                continue;
            }

            if (raw.kind === "session") {
                compact.session = fromUsed(raw.percent, raw.resets_at);
            } else if (raw.kind === "weekly_all") {
                compact.weekly = fromUsed(raw.percent, raw.resets_at);
            } else if (raw.kind === "weekly_scoped" && raw.scope?.model?.display_name?.toLowerCase() === "fable") {
                compact.fable = fromUsed(raw.percent, raw.resets_at);
            }
        }
    }

    compact.session ??= fromBucket(usage.five_hour);
    compact.weekly ??= fromBucket(usage.seven_day);

    return compact;
}
