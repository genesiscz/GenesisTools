import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import { spendBucketKey } from "@genesiscz/utils/ai/usage/series-keys";
import type { TranscriptGrain } from "./series";

/**
 * The spend pivot (design 2026-11-01, step U11, proposal 10): transcript spend split by any of these dimensions and
 * bucketed by hour, day or week in the asked zone, with an optional hour-by-weekday heatmap. A Claude session reaches
 * an account only through its pin, so its `account` is "(no account)" without one, never a guessed account.
 */
export const PIVOT_DIMENSIONS = ["provider", "account", "model", "project", "harness", "session"] as const;

export type PivotDimension = (typeof PIVOT_DIMENSIONS)[number];

export function isPivotDimension(value: string): value is PivotDimension {
    return (PIVOT_DIMENSIONS as readonly string[]).includes(value);
}

export const NO_ACCOUNT = "(no account)";

export interface PivotPoint {
    /** The bucket key: `YYYY-MM-DDTHH`, `YYYY-MM-DD`, or the Monday of the week. */
    t: string;
    costUsd: number;
    tokens: number;
}

export interface PivotGroup {
    key: Partial<Record<PivotDimension, string>>;
    costUsd: number;
    tokens: number;
    /** Events with no known rate: their dollars are missing, not zero. */
    unpriced: number;
    points: PivotPoint[];
}

export interface SpendHeatmap {
    /** Average dollars per hour of the week: `cells[weekday][hour]`, Monday first, divided by the weeks in range. */
    cells: number[][];
    weeks: number;
}

export interface SpendPivot {
    grain: TranscriptGrain;
    tz: string;
    by: PivotDimension[];
    groups: PivotGroup[];
    total: { costUsd: number; tokens: number; unpriced: number };
    heatmap: SpendHeatmap | null;
}

function dimensionValue(event: AttributedEvent, dimension: PivotDimension): string {
    const values: Record<PivotDimension, () => string> = {
        provider: () => event.provider,
        account: () => event.account.account?.accountName ?? NO_ACCOUNT,
        model: () => event.model ?? "?",
        project: () => event.owner.project || "?",
        harness: () => event.agent,
        session: () => event.owner.leadSessionId,
    };

    return values[dimension]();
}

const WEEKDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function weekdayHour(at: number, formatter: Intl.DateTimeFormat): [number, number] {
    const parts = formatter.formatToParts(new Date(at));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return [WEEKDAY[get("weekday")] ?? 0, Number(get("hour")) % 24];
}

export function pivotSpend(input: {
    events: readonly AttributedEvent[];
    from: number;
    to: number;
    grain: TranscriptGrain;
    tz: string;
    by: readonly PivotDimension[];
    heatmap: boolean;
}): SpendPivot {
    const groups = new Map<string, PivotGroup & { byBucket: Map<string, PivotPoint> }>();
    const total = { costUsd: 0, tokens: 0, unpriced: 0 };
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: input.tz,
        weekday: "short",
        hour: "2-digit",
        hourCycle: "h23",
    });

    for (const event of input.events) {
        if (event.at < input.from || event.at >= input.to) {
            continue;
        }

        const key: PivotGroup["key"] = {};

        for (const dimension of input.by) {
            key[dimension] = dimensionValue(event, dimension);
        }

        const id = input.by.map((dimension) => key[dimension]).join("\u0000");
        let group = groups.get(id);

        if (!group) {
            group = { key, costUsd: 0, tokens: 0, unpriced: 0, points: [], byBucket: new Map() };
            groups.set(id, group);
        }

        const t = spendBucketKey(new Date(event.at).toISOString(), input.grain, input.tz);
        const point = group.byBucket.get(t) ?? { t, costUsd: 0, tokens: 0 };
        point.costUsd += event.costUsd;
        point.tokens += event.tokens;
        group.byBucket.set(t, point);
        group.costUsd += event.costUsd;
        group.tokens += event.tokens;
        group.unpriced += event.unpriced ? 1 : 0;
        total.costUsd += event.costUsd;
        total.tokens += event.tokens;
        total.unpriced += event.unpriced ? 1 : 0;

        if (input.heatmap) {
            const [weekday, hour] = weekdayHour(event.at, formatter);
            cells[weekday][hour] += event.costUsd;
        }
    }

    const weeks = Math.max((input.to - input.from) / (7 * 86_400_000), 1 / 7);

    return {
        grain: input.grain,
        tz: input.tz,
        by: [...input.by],
        groups: [...groups.values()]
            .map(({ byBucket, ...group }) => ({
                ...group,
                points: [...byBucket.values()].sort((a, b) => a.t.localeCompare(b.t)),
            }))
            .sort((a, b) => b.costUsd - a.costUsd),
        total,
        heatmap: input.heatmap ? { cells: cells.map((row) => row.map((usd) => usd / weeks)), weeks } : null,
    };
}
