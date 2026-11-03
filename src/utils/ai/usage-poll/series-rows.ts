/**
 * Pure shaping of `usage_snapshots` rows into series: grouping, reset detection and the three
 * aggregate modes of `UsageLimitsDb.getSeries`. Kept apart from the SQL so each mode is tested
 * on plain rows.
 */

/** How a bin is drawn. `last` keeps each bin's last row (the old behaviour), `minmax` its open, close, min and max, `raw` every row. */
export type SeriesAgg = "raw" | "last" | "minmax";

export interface SeriesPoint {
    t: string;
    percent: number;
    resetsAt: string | null;
    severity: string | null;
}

export interface SeriesBin {
    /** Bin start: the bucket start, or the first row after a reset when a reset split the bucket. */
    t: string;
    open: number;
    close: number;
    min: number;
    max: number;
    /** The worst severity of the bin's rows. */
    severity: string | null;
}

/** A stretch of time in which the window had one availability state. */
export interface AvailabilitySpan {
    from: string;
    to: string;
    /** `unknown` is a row written before the store recorded availability. */
    state: "limited" | "absent" | "unknown";
}

interface SeriesEntryBase {
    /** Plugin id the rows came from. Set even when the query did not name one. */
    provider: string;
    account: string;
    /** The provider-native window key, stored in the `bucket` column. */
    key: string;
    /**
     * Window kind (`session`, `weekly`, ...). Part of the series identity: a Codex `primary` slot
     * can hold the 5h window for one plan and the weekly one for another. A row written before
     * the kind column takes the kind of its neighbours.
     */
    kind: string | null;
    /** The newest non-null `scope_model` of the rows. */
    scopeModel: string | null;
    /** Instants a new window began, read from every row in the range, so no step can hide one. */
    resets: string[];
    /** The window's availability from its first row in the range to the range's end, one span per state change. */
    availability: AvailabilitySpan[];
}

export interface SeriesEntry extends SeriesEntryBase {
    points: SeriesPoint[];
}

export interface SeriesBinEntry extends SeriesEntryBase {
    bins: SeriesBin[];
}

/** One row as the series query selects it, severity already normalised. */
export interface SeriesRow {
    provider: string;
    account: string;
    key: string;
    kind: string | null;
    scopeModel: string | null;
    t: string;
    percent: number;
    resetsAt: string | null;
    severity: string | null;
    /** The stored state; null is a row from before the column. An `absent` row carries no reading. */
    availability: "limited" | "absent" | null;
}

export interface SeriesGroup extends Omit<SeriesEntryBase, "resets" | "availability"> {
    rows: SeriesRow[];
}

/**
 * Rows sorted by provider, account, key and time, grouped into series. Within one
 * provider/account/key run, a NULL kind takes the last kind seen before it, or the first kind
 * after it when it leads the run; a change of kind starts a new series.
 */
export function groupSeriesRows(rows: readonly SeriesRow[]): SeriesGroup[] {
    const groups = new Map<string, SeriesGroup>();
    let runKey: string | null = null;
    let carried: string | null = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const run = `${row.provider}\u0000${row.account}\u0000${row.key}`;

        if (run !== runKey) {
            runKey = run;
            carried = firstKindOfRun(rows, i, run);
        }

        if (row.kind !== null) {
            carried = row.kind;
        }

        const kind = row.kind ?? carried;
        const id = `${run}\u0000${kind ?? ""}`;
        let group = groups.get(id);

        if (!group) {
            group = { provider: row.provider, account: row.account, key: row.key, kind, scopeModel: null, rows: [] };
            groups.set(id, group);
        }

        if (row.scopeModel !== null) {
            group.scopeModel = row.scopeModel;
        }

        group.rows.push(row);
    }

    return [...groups.values()];
}

function firstKindOfRun(rows: readonly SeriesRow[], start: number, run: string): string | null {
    for (let i = start; i < rows.length; i++) {
        const row = rows[i];

        if (`${row.provider}\u0000${row.account}\u0000${row.key}` !== run) {
            return null;
        }

        if (row.kind !== null) {
            return row.kind;
        }
    }

    return null;
}

/**
 * The instant a new window began between two consecutive rows, or null. A window reset when
 * `resets_at` moved later (beyond the poll jitter) or vanished after its end passed. The instant
 * is the old window's end when that came before the later row, else the later row's time (a
 * provider that moved the reset early).
 */
export function resetBetween(
    a: Pick<SeriesRow, "t" | "resetsAt">,
    b: Pick<SeriesRow, "t" | "resetsAt">,
    roughlyEqual: (x: string | null, y: string | null) => boolean
): string | null {
    if (a.resetsAt === null) {
        return null;
    }

    const end = Date.parse(a.resetsAt);
    const next = Date.parse(b.t);

    if (!Number.isFinite(end) || !Number.isFinite(next)) {
        return null;
    }

    if (b.resetsAt === null) {
        return end <= next ? new Date(end).toISOString() : null;
    }

    if (roughlyEqual(a.resetsAt, b.resetsAt) || !(Date.parse(b.resetsAt) > end)) {
        return null;
    }

    return end <= next ? new Date(end).toISOString() : b.t;
}

const SEVERITY_RANK: Record<string, number> = { ok: 0, warn: 1, critical: 2 };

function worse(a: string | null, b: string | null): string | null {
    if (a === null) {
        return b;
    }

    if (b === null) {
        return a;
    }

    return (SEVERITY_RANK[b] ?? -1) > (SEVERITY_RANK[a] ?? -1) ? b : a;
}

function pointOf(row: SeriesRow): SeriesPoint {
    return { t: row.t, percent: row.percent, resetsAt: row.resetsAt, severity: row.severity };
}

/** Keeps the last point of each fixed-width bucket. `step <= 0` keeps every point. */
export function lastPerBucket(points: readonly SeriesPoint[], step: number): SeriesPoint[] {
    if (step <= 0) {
        return [...points];
    }

    const out: SeriesPoint[] = [];
    let currentBucket: number | null = null;

    for (const point of points) {
        const bucket = Math.floor(Date.parse(point.t) / step);

        if (bucket === currentBucket) {
            out[out.length - 1] = point;
            continue;
        }

        currentBucket = bucket;
        out.push(point);
    }

    return out;
}

/**
 * Open, close, min and max per fixed-width bucket, over the rows written inside it. A reset
 * inside a bucket closes the bin and opens another at the first row after it, so the peak before
 * a reset and the drop after it both survive any step. `step <= 0` gives one bin per row.
 */
export function minMaxBins(rows: readonly SeriesRow[], step: number, resetBefore: readonly boolean[]): SeriesBin[] {
    const out: SeriesBin[] = [];
    let bucketOfLast: number | null = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const bucket = step > 0 ? Math.floor(Date.parse(row.t) / step) : i;
        const last = out.at(-1);
        const split = resetBefore[i] === true;

        if (last && bucket === bucketOfLast && !split) {
            last.close = row.percent;
            last.min = Math.min(last.min, row.percent);
            last.max = Math.max(last.max, row.percent);
            last.severity = worse(last.severity, row.severity);
            continue;
        }

        const start = step > 0 && bucket !== bucketOfLast ? new Date(bucket * step).toISOString() : row.t;
        bucketOfLast = bucket;
        out.push({
            t: start,
            open: row.percent,
            close: row.percent,
            min: row.percent,
            max: row.percent,
            severity: row.severity,
        });
    }

    return out;
}

export interface ShapeOptions {
    step: number;
    roughlyEqual: (x: string | null, y: string | null) => boolean;
    /** The range's end (ISO), where the last availability span stops. */
    to: string;
}

/**
 * The availability spans of a group's rows, absent rows included. Each span runs from the row
 * that began a state to the row that changed it, the last one to the range's end.
 */
export function availabilitySpans(rows: readonly SeriesRow[], to: string): AvailabilitySpan[] {
    const spans: AvailabilitySpan[] = [];

    for (const row of rows) {
        const state = row.availability ?? "unknown";
        const open = spans.at(-1);

        if (open?.state === state) {
            continue;
        }

        if (open) {
            open.to = row.t;
        }

        spans.push({ from: row.t, to, state });
    }

    return spans;
}

/** The rows that carry a reading: every row but the ones that only mark the window gone. */
function readings(rows: readonly SeriesRow[]): SeriesRow[] {
    return rows.filter((row) => row.availability !== "absent");
}

function resetsOf(rows: readonly SeriesRow[], roughlyEqual: ShapeOptions["roughlyEqual"]) {
    const resets: string[] = [];
    const resetBefore: boolean[] = [false];

    for (let i = 1; i < rows.length; i++) {
        const at = resetBetween(rows[i - 1], rows[i], roughlyEqual);
        resetBefore.push(at !== null);

        if (at !== null) {
            resets.push(at);
        }
    }

    return { resets, resetBefore };
}

export function shapePoints(group: SeriesGroup, agg: "raw" | "last", opts: ShapeOptions): SeriesEntry {
    const { rows, ...base } = group;
    const read = readings(rows);
    const points = read.map(pointOf);

    return {
        ...base,
        resets: resetsOf(read, opts.roughlyEqual).resets,
        availability: availabilitySpans(rows, opts.to),
        points: agg === "raw" ? points : lastPerBucket(points, opts.step),
    };
}

export function shapeBins(group: SeriesGroup, opts: ShapeOptions): SeriesBinEntry {
    const { rows, ...base } = group;
    const read = readings(rows);
    const { resets, resetBefore } = resetsOf(read, opts.roughlyEqual);

    return {
        ...base,
        resets,
        availability: availabilitySpans(rows, opts.to),
        bins: minMaxBins(read, opts.step, resetBefore),
    };
}
