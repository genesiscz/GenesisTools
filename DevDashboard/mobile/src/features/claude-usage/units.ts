import type { AccountUsage, MultiBucketHistoryResult } from "@dd/contract";
import type { MetricPoint } from "@/ui/MetricChart";

/**
 * Pure value formatters + mappers for the claude-usage screen. Reimplemented locally (NOT imported
 * from `@app/*`) so the RN bundle never drags web/server code in. Only contract TYPES + `Date.parse`
 * are used — no RN runtime — so this runs under `bun:test`.
 */

export const DASH = "—";

/**
 * One usage bucket (`{ utilization, resets_at }`). Derived from the contract's `AccountUsage` rather
 * than imported directly: the contract re-exports `AccountUsage` but NOT the underlying `UsageBucket`
 * type, and the contract is shared/read-only (out of scope to extend). Indexing the `usage` map's
 * value type keeps this in lockstep with the contract without touching it.
 */
export type UsageBucket = NonNullable<NonNullable<AccountUsage["usage"]>["five_hour"]>;

/** A bucket's history mapped for the shared single-series `MetricChart`. */
export interface BucketChartSeries {
    /** Stable bucket id (the contract bucket key, e.g. "five_hour"). */
    key: string;
    /** Short human label for the chart title ("5h", "7d", …). */
    label: string;
    /** Points ready for `MetricChart` (ts = epoch ms, value = utilization percent 0-100). */
    points: MetricPoint[];
}

const BUCKET_LABELS: Record<string, string> = {
    five_hour: "5h",
    seven_day: "7d",
    seven_day_sonnet: "Sonnet 7d",
    seven_day_opus: "Opus 7d",
    seven_day_oauth_apps: "OAuth apps 7d",
};

/** Short label for a contract bucket key (falls back to the raw key). */
export function bucketLabel(bucket: string): string {
    return BUCKET_LABELS[bucket] ?? bucket;
}

/** Utilization (0-1) → rounded integer percent string; null/undefined → em dash. */
export function utilizationPct(bucket: UsageBucket | null | undefined): string {
    if (!bucket || typeof bucket.utilization !== "number") {
        return DASH;
    }

    return `${Math.round(bucket.utilization * 100)}%`;
}

/** ISO string → 24h `HH:MM`; null/invalid → em dash. */
export function clock(iso: string | null): string {
    if (!iso) {
        return DASH;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return DASH;
    }

    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/**
 * Map a `MultiBucketHistoryResult` to one `BucketChartSeries` per bucket. Each snapshot's
 * `timestamp` → epoch-ms x, `utilization` (0-1) → percent (0-100) y. Snapshots with an unparseable
 * timestamp are dropped. The shipped `MetricChart` is single-series, so the screen renders one chart
 * per returned series (the token burn-down per bucket).
 */
export function historyToBucketSeries(history: MultiBucketHistoryResult): BucketChartSeries[] {
    return history.series.map((series) => {
        const points: MetricPoint[] = [];

        for (const snapshot of series.snapshots) {
            const ts = Date.parse(snapshot.timestamp);
            if (Number.isNaN(ts)) {
                continue;
            }

            points.push({ ts, value: snapshot.utilization * 100 });
        }

        return { key: series.bucket, label: bucketLabel(series.bucket), points };
    });
}
