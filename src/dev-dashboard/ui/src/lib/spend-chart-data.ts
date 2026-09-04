import type { SpendBucket, SpendSeriesPoint } from "@app/dev-dashboard/contract/ai-accounts";

export type SpendChartMode = "stacked" | "lines" | "total" | "byModel";

export const SPEND_CHART_MODES: ReadonlyArray<{ value: SpendChartMode; label: string }> = [
    { value: "stacked", label: "Stacked" },
    { value: "lines", label: "Lines" },
    { value: "total", label: "Total" },
    { value: "byModel", label: "By model" },
];

export interface SpendChartRow {
    t: number;
    [key: string]: number;
}

export interface SpendChartData {
    rows: SpendChartRow[];
    /** Series keys in legend order: account ids, model ids, or `total`. */
    keys: string[];
}

export const TOTAL_KEY = "total";

/** `YYYY-MM-DD`, optionally `THH` or `THH:mm`. Anything else falls through to `Date`. */
const BUCKET_KEY = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?$/;

/**
 * Bucket keys from `spendBucketKey` are LOCAL wall-clock and truncated, so
 * `2026-09-04T20` is 8pm here, not a UTC instant. `new Date()` rejects the hour
 * form outright and reads the day form as UTC midnight, which drops every
 * hour-grain point and shifts every day-grain point by the offset. Parse the
 * shape ourselves and let a real ISO instant take the native path.
 */
export function parseBucketTime(key: string): number {
    const parts = BUCKET_KEY.exec(key);

    if (!parts) {
        return new Date(key).getTime();
    }

    const [, year, month, day, hour, minute] = parts;
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        hour ? Number(hour) : 0,
        minute ? Number(minute) : 0
    ).getTime();
}

function visibleBuckets(point: SpendSeriesPoint, hidden: ReadonlySet<string>): Array<[string, SpendBucket]> {
    return Object.entries(point.byAccount).filter(([accountId]) => !hidden.has(accountId));
}

/**
 * Shape the series for recharts. Hidden accounts are removed before summing,
 * so `total` mode reflects the toggles, not the server total. Keys are the
 * union over the window so a series that appears late still gets a legend
 * entry from the first row on (recharts wants every key on every row).
 */
export function buildSpendChartData(
    points: readonly SpendSeriesPoint[],
    options: { mode: SpendChartMode; hiddenAccountIds: ReadonlySet<string> }
): SpendChartData {
    const { mode, hiddenAccountIds } = options;
    const keySet = new Set<string>();
    const partial: Array<{ t: number; values: Record<string, number> }> = [];

    for (const point of points) {
        const t = parseBucketTime(point.t);

        if (Number.isNaN(t)) {
            continue;
        }

        const values: Record<string, number> = {};

        if (mode === "total") {
            values[TOTAL_KEY] = visibleBuckets(point, hiddenAccountIds).reduce((sum, [, b]) => sum + b.costUsd, 0);
        } else if (mode === "byModel") {
            for (const [model, bucket] of Object.entries(point.byModel ?? {})) {
                values[model] = bucket.costUsd;
            }
        } else {
            for (const [accountId, bucket] of visibleBuckets(point, hiddenAccountIds)) {
                values[accountId] = bucket.costUsd;
            }
        }

        for (const key of Object.keys(values)) {
            keySet.add(key);
        }

        partial.push({ t, values });
    }

    partial.sort((a, b) => a.t - b.t);
    const keys = [...keySet];
    const rows: SpendChartRow[] = partial.map(({ t, values }) => {
        const row: SpendChartRow = { t };

        for (const key of keys) {
            row[key] = values[key] ?? 0;
        }

        return row;
    });

    return { rows, keys };
}

/** Sum a window for the totals row, respecting hidden accounts. */
export function sumVisible(points: readonly SpendSeriesPoint[], hidden: ReadonlySet<string>): SpendBucket {
    let costUsd = 0;
    let tokens = 0;

    for (const point of points) {
        for (const [, bucket] of visibleBuckets(point, hidden)) {
            costUsd += bucket.costUsd;
            tokens += bucket.tokens;
        }
    }

    return { costUsd, tokens };
}

export function formatUsd(value: number): string {
    if (value === 0) {
        return "$0";
    }

    if (value < 0.01) {
        return `$${value.toFixed(4)}`;
    }

    if (value >= 1000) {
        return `$${Math.round(value).toLocaleString()}`;
    }

    return `$${value.toFixed(2)}`;
}
