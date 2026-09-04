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
        const t = new Date(point.t).getTime();

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
