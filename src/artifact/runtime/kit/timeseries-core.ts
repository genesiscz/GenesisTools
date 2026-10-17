import { composeHash, hashSegments } from "./hash";

/**
 * Pure helpers behind the TimeSeries chart: time and value ticks, min/max
 * decimation, nearest-point search, range math, stacking, lane packing,
 * marker clustering, panel assignment, CSV and state encoding. Nothing here
 * touches the DOM, so every function is unit-tested on its own.
 */

/** One sample: [epoch ms, value]; a null value is a gap in the line. */
export type TsPoint = [number, number | null];

export type TsRange = [number, number];

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ─── Search ───

/** First index whose time is >= t (points.length when none). */
export function lowerBound(points: readonly TsPoint[], t: number): number {
    let lo = 0;
    let hi = points.length;

    while (lo < hi) {
        const mid = (lo + hi) >>> 1;

        if (points[mid][0] < t) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    return lo;
}

/** First index whose time is > t (points.length when none). */
export function upperBound(points: readonly TsPoint[], t: number): number {
    let lo = 0;
    let hi = points.length;

    while (lo < hi) {
        const mid = (lo + hi) >>> 1;

        if (points[mid][0] <= t) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    return lo;
}

/**
 * Index of the non-null point closest in time to `t`, or -1. With `maxDistance`
 * a point farther away than that does not count.
 */
export function nearestIndex(points: readonly TsPoint[], t: number, maxDistance = Number.POSITIVE_INFINITY): number {
    const at = lowerBound(points, t);
    let best = -1;
    let bestDistance = maxDistance;

    for (let i = at; i < points.length; i += 1) {
        if (points[i][1] === null) {
            continue;
        }

        const d = points[i][0] - t;

        if (d <= bestDistance) {
            best = i;
            bestDistance = d;
        }

        break;
    }

    for (let i = at - 1; i >= 0; i -= 1) {
        if (points[i][1] === null) {
            continue;
        }

        const d = t - points[i][0];

        if (d < bestDistance || (d === bestDistance && best === -1)) {
            best = i;
        }

        break;
    }

    return best;
}

/** Step semantics: the value of the last point at or before `t` (null before the first point or in a gap). */
export function valueAt(points: readonly TsPoint[], t: number): number | null {
    const i = upperBound(points, t) - 1;

    return i >= 0 ? points[i][1] : null;
}

// ─── Range math ───

export interface ClampOptions {
    /** Data bounds the view may not leave. */
    bounds: TsRange;
    /** Smallest span the view may shrink to (ms). */
    minSpan?: number;
}

/** Keep a view inside the bounds, at least `minSpan` wide and never wider than the bounds. */
export function clampRange(range: TsRange, { bounds, minSpan = SECOND }: ClampOptions): TsRange {
    const full = Math.max(bounds[1] - bounds[0], 1);
    let span = Math.min(Math.max(range[1] - range[0], Math.min(minSpan, full)), full);
    let start = range[0];

    if (!Number.isFinite(span) || span <= 0) {
        span = full;
    }

    if (!Number.isFinite(start)) {
        start = bounds[0];
    }

    start = Math.min(Math.max(start, bounds[0]), bounds[1] - span);

    return [start, start + span];
}

export interface ZoomOptions extends ClampOptions {
    /** Factor > 1 zooms out, < 1 zooms in. */
    factor: number;
    /** Time that stays under the cursor. Default: the view center. */
    anchor?: number;
}

/** Scale a view around an anchor time, then clamp it. */
export function zoomRange(range: TsRange, { factor, anchor, bounds, minSpan }: ZoomOptions): TsRange {
    const a = anchor ?? (range[0] + range[1]) / 2;
    const next: TsRange = [a - (a - range[0]) * factor, a + (range[1] - a) * factor];

    return clampRange(next, { bounds, minSpan });
}

/** Shift a view by `delta` ms, keeping its span. */
export function panRange(range: TsRange, delta: number, bounds: TsRange): TsRange {
    return clampRange([range[0] + delta, range[1] + delta], { bounds, minSpan: range[1] - range[0] });
}

/** A view of `span` ms centered on `center`, clamped. */
export function rangeAround(center: number, span: number, bounds: TsRange): TsRange {
    return clampRange([center - span / 2, center + span / 2], { bounds, minSpan: span });
}

// ─── Decimation ───

/**
 * Points to draw for the view [t0, t1] at `buckets` pixel columns.
 *
 * With at most two points per column the raw points come back, so a single
 * call stays a single vertex. Denser data is reduced per column to its first,
 * min, max and last point in time order (M4), so a one-call drop still draws
 * as a full vertical line at any zoom. One point on each side of the view is
 * kept so lines run to the edges. A null splits the line where it occurs.
 */
export function decimate(points: readonly TsPoint[], t0: number, t1: number, buckets: number): TsPoint[] {
    if (points.length === 0) {
        return [];
    }

    const first = lowerBound(points, t0);
    const end = upperBound(points, t1);
    const from = Math.max(0, first - 1);
    const to = Math.min(points.length, end + 1);
    const cols = Math.max(1, Math.floor(buckets));

    if (end - first <= cols * 2) {
        return points.slice(from, to);
    }

    const out: TsPoint[] = [];

    if (from < first) {
        out.push(points[from]);
    }

    const width = (t1 - t0) / cols;
    let bucket = -1;
    let count = 0;
    let fT = 0;
    let fV = 0;
    let lT = 0;
    let lV = 0;
    let minT = 0;
    let minV = 0;
    let maxT = 0;
    let maxV = 0;

    const flush = () => {
        if (count === 0) {
            return;
        }

        const picks: TsPoint[] = [
            [fT, fV],
            [minT, minV],
            [maxT, maxV],
            [lT, lV],
        ];
        picks.sort((a, b) => a[0] - b[0]);
        let prev = Number.NaN;

        for (const p of picks) {
            if (p[0] !== prev) {
                out.push(p);
                prev = p[0];
            }
        }

        count = 0;
    };

    for (let i = first; i < end; i += 1) {
        const [t, v] = points[i];
        const b = Math.min(cols - 1, Math.floor((t - t0) / width));

        if (b !== bucket) {
            flush();
            bucket = b;
        }

        if (v === null) {
            flush();
            out.push([t, null]);

            continue;
        }

        if (count === 0) {
            fT = t;
            fV = v;
            minT = t;
            minV = v;
            maxT = t;
            maxV = v;
        }

        if (v < minV) {
            minT = t;
            minV = v;
        }

        if (v > maxV) {
            maxT = t;
            maxV = v;
        }

        lT = t;
        lV = v;
        count += 1;
    }

    flush();

    if (end < to) {
        out.push(points[end]);
    }

    return out;
}

/** Min and max of the non-null values with time inside [t0, t1]; null when there are none. */
export function extentIn(points: readonly TsPoint[], t0: number, t1: number): [number, number] | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let i = lowerBound(points, t0); i < points.length && points[i][0] <= t1; i += 1) {
        const v = points[i][1];

        if (v !== null && Number.isFinite(v)) {
            min = Math.min(min, v);
            max = Math.max(max, v);
        }
    }

    return min <= max ? [min, max] : null;
}

// ─── Stacking ───

export interface StackedPoints {
    /** Cumulative top on the union of layer change times. Nulls retain gaps. */
    top: TsPoint[];
    /** Cumulative bottom (the layers below) at the same times. */
    base: TsPoint[];
}

/**
 * Stack layers in order (first = bottom) on their shared change-time grid.
 * Every layer holds its last sample until the next change, including after its
 * last timestamp. Before its first sample and during a null run it is absent.
 * A null layer contributes zero below higher layers, while its own top stays null.
 * The left limit at a gap boundary is retained so a step fill reaches the gap.
 */
export function stackPoints(layers: ReadonlyArray<readonly TsPoint[]>): StackedPoints[] {
    const out: StackedPoints[] = layers.map(() => ({ top: [], base: [] }));
    const times = [...new Set(layers.flatMap((layer) => layer.map(([t]) => t)))].sort((a, b) => a - b);
    const positions = layers.map(() => -1);

    for (const t of times) {
        let below = 0;

        for (const [index, layer] of layers.entries()) {
            while (positions[index] + 1 < layer.length && layer[positions[index] + 1][0] <= t) {
                positions[index] += 1;
            }

            const v = positions[index] < 0 ? null : layer[positions[index]][1];
            const { top, base } = out[index];
            const previous = top.at(-1);

            if (v === null && previous && previous[1] !== null) {
                top.push([t, previous[1]]);
                base.push([t, base[base.length - 1][1]]);
            }

            base.push([t, below]);
            top.push([t, v === null ? null : below + Math.max(0, v)]);
            below += Math.max(0, v ?? 0);
        }
    }

    return out;
}

// ─── Ticks ───

export interface TimeTick {
    t: number;
    label: string;
    /** First tick of a new local day (or month on day steps). */
    major: boolean;
}

const TIME_STEPS = [
    SECOND,
    2 * SECOND,
    5 * SECOND,
    10 * SECOND,
    15 * SECOND,
    30 * SECOND,
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
    30 * DAY,
    91 * DAY,
    365 * DAY,
];

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
    let f = partsFormatters.get(timeZone);

    if (!f) {
        f = new Intl.DateTimeFormat("en-GB", {
            timeZone,
            hourCycle: "h23",
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        partsFormatters.set(timeZone, f);
    }

    return f;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface LocalParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: string;
    monthName: string;
}

/** Wall-clock parts of `t` in `timeZone`. */
export function localParts(t: number, timeZone: string): LocalParts {
    const parts: Record<string, string> = {};

    for (const p of partsFormatter(timeZone).formatToParts(t)) {
        parts[p.type] = p.value;
    }

    const monthName = parts.month ?? "Jan";

    return {
        year: Number(parts.year),
        month: Math.max(0, MONTHS.indexOf(monthName)),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        second: Number(parts.second),
        weekday: parts.weekday ?? "",
        monthName,
    };
}

/** Offset of `timeZone` from UTC at instant `t`, in ms (Prague in summer: +2 h). */
export function tzOffset(t: number, timeZone: string): number {
    const p = localParts(t, timeZone);
    const wall = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);

    return wall - Math.floor(t / SECOND) * SECOND;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** "14:05", "14:05:09", "Tue 14 Oct", "14 Oct 2026" as needed. */
export function formatTime(t: number, timeZone: string, style: "time" | "seconds" | "day" | "full" = "full"): string {
    const p = localParts(t, timeZone);
    const hm = `${pad2(p.hour)}:${pad2(p.minute)}`;

    if (style === "time") {
        return hm;
    }

    if (style === "seconds") {
        return `${hm}:${pad2(p.second)}`;
    }

    if (style === "day") {
        return `${p.weekday} ${p.day} ${p.monthName}`;
    }

    return `${p.weekday} ${p.day} ${p.monthName} ${hm}:${pad2(p.second)}`;
}

/** "45s", "12m", "3h 20m", "2d 4h". */
export function formatDurationShort(ms: number): string {
    const abs = Math.abs(ms);
    const sign = ms < 0 ? "-" : "";

    if (abs < MINUTE) {
        return `${sign}${Math.round(abs / SECOND)}s`;
    }

    if (abs < HOUR) {
        const m = Math.floor(abs / MINUTE);
        const s = Math.floor((abs % MINUTE) / SECOND);

        return `${sign}${m}m${s ? ` ${s}s` : ""}`;
    }

    if (abs < DAY) {
        const h = Math.floor(abs / HOUR);
        const m = Math.floor((abs % HOUR) / MINUTE);

        return `${sign}${h}h${m ? ` ${m}m` : ""}`;
    }

    const d = Math.floor(abs / DAY);
    const h = Math.floor((abs % DAY) / HOUR);

    return `${sign}${d}d${h ? ` ${h}h` : ""}`;
}

export interface TimeTicksOptions {
    range: TsRange;
    /** Plot width in px. */
    width: number;
    timeZone: string;
    /** Smallest gap between ticks (px). */
    minGap?: number;
}

/** The tick step (ms) for a span drawn over `width` px. */
export function timeStep(span: number, width: number, minGap = 90): number {
    const perPx = span / Math.max(width, 1);

    return TIME_STEPS.find((step) => step / perPx >= minGap) ?? TIME_STEPS[TIME_STEPS.length - 1];
}

/**
 * Time-axis ticks aligned on the wall clock of `timeZone`: seconds to days,
 * chosen so ticks sit at least `minGap` px apart. Ticks on a local midnight
 * are major and carry the day instead of the time.
 */
export function timeTicks({ range, width, timeZone, minGap = 90 }: TimeTicksOptions): TimeTick[] {
    const [t0, t1] = range;

    if (!(t1 > t0) || width <= 0) {
        return [];
    }

    const step = timeStep(t1 - t0, width, minGap);
    const off0 = tzOffset(t0, timeZone);
    const ticks: TimeTick[] = [];
    const toInstant = (wall: number) => {
        const guess = wall - off0;
        const t = wall - tzOffset(guess, timeZone);
        // A nonexistent local time cannot round-trip through the zone's actual offset.
        return t + tzOffset(t, timeZone) === wall ? t : Number.NaN;
    };

    if (step < DAY) {
        let wall = Math.ceil((t0 + off0) / step) * step;

        for (let guard = 0; guard < 500; guard += 1, wall += step) {
            const t = toInstant(wall);

            if (!Number.isFinite(t) || t < t0 || t <= (ticks.at(-1)?.t ?? -Infinity)) {
                continue;
            }

            if (t > t1) {
                break;
            }

            const p = localParts(t, timeZone);
            const midnight = p.hour === 0 && p.minute === 0 && p.second === 0;
            const label = midnight
                ? formatTime(t, timeZone, "day")
                : step < MINUTE
                  ? formatTime(t, timeZone, "seconds")
                  : formatTime(t, timeZone, "time");
            ticks.push({ t, label, major: midnight });
        }

        return ticks;
    }

    const days = Math.round(step / DAY);
    const months = days >= 365 ? 12 : days >= 90 ? 3 : days >= 28 ? 1 : 0;
    const start = localParts(t0, timeZone);
    let month = Math.floor(start.month / (months || 1)) * (months || 1);
    let wall = months ? Date.UTC(start.year, month, 1) : Math.ceil((t0 + off0) / step) * step;

    // Advance calendar intervals directly; the safety cap counts ticks, not days scanned.
    while (ticks.length < 500 && Number.isFinite(wall)) {
        const t = toInstant(wall);

        if (t > t1) {
            break;
        }

        if (Number.isFinite(t) && t >= t0 && t > (ticks.at(-1)?.t ?? -Infinity)) {
            const p = localParts(t, timeZone);
            const label = months ? `${p.monthName} ${p.year}` : `${p.day} ${p.monthName}`;
            ticks.push({ t, label, major: p.day === 1 });
        }

        if (months) {
            month += months;
            wall = Date.UTC(start.year, month, 1);
        } else {
            wall += step;
        }
    }

    return ticks;
}

/** 1/2/5 x 10^n step close to `raw`. */
export function niceStep(raw: number): number {
    if (!(raw > 0) || !Number.isFinite(raw)) {
        return 1;
    }

    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const m = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;

    return m * mag;
}

export interface ValueScale {
    min: number;
    max: number;
    ticks: number[];
}

/** Linear axis: a nice domain covering [min, max] and its ticks (about `count`). */
export function niceScale(min: number, max: number, count = 5): ValueScale {
    let lo = min;
    let hi = max;

    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        return { min: 0, max: 1, ticks: [0, 0.5, 1] };
    }

    if (lo === hi) {
        const pad = Math.abs(lo) * 0.1 || 1;
        lo -= pad;
        hi += pad;
    }

    const step = niceStep((hi - lo) / Math.max(1, count));
    const nMin = Math.floor(lo / step + 1e-9) * step;
    const nMax = Math.ceil(hi / step - 1e-9) * step;
    const ticks: number[] = [];

    for (let v = nMin; v <= nMax + step / 2 && ticks.length < 50; v += step) {
        ticks.push(Number(v.toPrecision(12)));
    }

    return { min: nMin, max: nMax, ticks };
}

/** Log axis over positive values: decades, with 2 and 5 between when there are few decades. */
export function logScale(min: number, max: number): ValueScale {
    const smallest = Math.max(min, Number.MIN_VALUE);
    let lowerExponent = Math.max(-324, Math.floor(Math.log10(smallest)));
    let lo = Math.max(Number.MIN_VALUE, 10 ** lowerExponent);

    if (lo > smallest && lowerExponent > -324) {
        lowerExponent -= 1;
        lo = Math.max(Number.MIN_VALUE, 10 ** lowerExponent);
    }

    const largest = Math.max(max, Math.min(Number.MAX_VALUE, lo * 10));
    let upperExponent = Math.min(309, Math.ceil(Math.log10(largest)));
    let hi = Math.min(Number.MAX_VALUE, 10 ** upperExponent);

    if (hi < largest && upperExponent < 309) {
        upperExponent += 1;
        hi = Math.min(Number.MAX_VALUE, 10 ** upperExponent);
    }

    const decades = Math.round(Math.log10(hi) - Math.log10(lo));
    const ticks: number[] = [];
    const addTick = (value: number): void => {
        if (!Number.isFinite(value) || value < lo || value > hi) {
            return;
        }

        const tick = Math.max(lo, Math.min(hi, Number(value.toPrecision(12))));

        if (tick > (ticks.at(-1) ?? 0)) {
            ticks.push(tick);
        }
    };

    // IEEE-754's finite positive range spans at most 634 candidate decades.
    for (let exponent = lowerExponent; exponent <= upperExponent; exponent += 1) {
        const d = Math.max(lo, Math.min(hi, 10 ** exponent));
        addTick(d);

        if (decades <= 3) {
            addTick(d * 2);
            addTick(d * 5);
        }
    }

    return { min: lo, max: hi, ticks };
}

// ─── Values ───

/** 950, 1.2k, 34k, 1.5M, 2.1B. */
export function compactNumber(v: number): string {
    const abs = Math.abs(v);

    if (abs >= 1e9) {
        return `${trimZeros((v / 1e9).toFixed(abs >= 1e10 ? 0 : 1))}B`;
    }

    if (abs >= 1e6) {
        return `${trimZeros((v / 1e6).toFixed(abs >= 1e7 ? 0 : 1))}M`;
    }

    if (abs >= 1e3) {
        return `${trimZeros((v / 1e3).toFixed(abs >= 1e4 ? 0 : 1))}k`;
    }

    if (abs === 0) {
        return "0";
    }

    return trimZeros(v.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3));
}

function trimZeros(s: string): string {
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Default value formatter for a unit name: "usd" and "$" print dollars, "%" a percentage, else compact. */
export function formatForUnit(unit: string | undefined): (v: number) => string {
    const u = (unit ?? "").toLowerCase();

    if (u === "usd" || u === "$") {
        return (v) => {
            const abs = Math.abs(v);

            if (abs >= 1000) {
                return `$${compactNumber(v)}`;
            }

            return `$${v.toFixed(abs >= 100 ? 0 : abs >= 1 ? 2 : abs === 0 ? 0 : 3)}`;
        };
    }

    if (u === "%" || u === "pct" || u === "percent" || u === "% of max") {
        return (v) => `${trimZeros(v.toFixed(Math.abs(v) >= 10 ? 0 : 1))}%`;
    }

    return compactNumber;
}

// ─── Lanes ───

export interface PackInput {
    start: number;
    end: number;
}

/**
 * Greedy interval packing: each item (in start order) goes into the first row
 * whose last item ended before it starts. Returns the row per input index.
 * Sorting and first-free-row lookup take O(n log n) time with O(n) storage.
 */
export function packRows(items: readonly PackInput[], gap = 0): number[] {
    const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || items[a].end - items[b].end);
    let firstLeaf = 1;

    while (firstLeaf < items.length) {
        firstLeaf *= 2;
    }

    // Each node holds the minimum reusable time in its row range. Searching left
    // first preserves the old lowest-row choice, even when higher rows ended earlier.
    const minReadyAt = new Array<number | undefined>(firstLeaf * 2);
    const rows = new Array<number>(items.length);
    let rowCount = 0;

    for (const i of order) {
        const item = items[i];
        const start = item.start;
        const earliest = minReadyAt[1];
        let row: number;
        let node = 1;

        if (earliest !== undefined && earliest <= start) {
            while (node < firstLeaf) {
                const left = node * 2;
                const leftReadyAt = minReadyAt[left];
                node = leftReadyAt !== undefined && leftReadyAt <= start ? left : left + 1;
            }

            row = node - firstLeaf;
        } else {
            row = rowCount;
            rowCount += 1;
        }

        rows[i] = row;
        node = firstLeaf + row;
        const readyAt = item.end + gap;
        minReadyAt[node] = Number.isNaN(readyAt) ? undefined : readyAt;

        while (node > 1) {
            node = Math.floor(node / 2);
            const left = minReadyAt[node * 2];
            const right = minReadyAt[node * 2 + 1];
            minReadyAt[node] = left === undefined ? right : right === undefined ? left : Math.min(left, right);
        }
    }

    return rows;
}

export interface LaneInput extends PackInput {
    lane?: string;
}

export interface LaneLayout {
    name: string;
    /** Rows this lane needs (overlapping spans stack into sub-rows). */
    rows: number;
    /** Indexes into the input array. */
    items: number[];
    /** Sub-row per entry of `items`. */
    itemRows: number[];
}

/** Name used for spans that carry no lane. */
export const DEFAULT_LANE = "Other";

/** Group spans by lane (first appearance order, unnamed last) and pack each lane into sub-rows. */
export function layoutLanes(spans: readonly LaneInput[]): LaneLayout[] {
    const groups = new Map<string, number[]>();

    for (const [i, s] of spans.entries()) {
        const key = s.lane ?? DEFAULT_LANE;
        const list = groups.get(key) ?? [];
        list.push(i);
        groups.set(key, list);
    }

    const names = [...groups.keys()].sort((a, b) => Number(a === DEFAULT_LANE) - Number(b === DEFAULT_LANE));

    return names.map((name) => {
        const items = groups.get(name) ?? [];
        const itemRows = packRows(items.map((i) => spans[i]));

        return { name, items, itemRows, rows: Math.max(1, ...itemRows.map((r) => r + 1)) };
    });
}

/**
 * Lanes packed from only the spans that overlap `range`, so the lanes area
 * shrinks to what is on screen. `order` fixes the lane order (and keeps lanes
 * with nothing visible as one empty row, so the labels do not jump).
 */
export function layoutLanesIn(spans: readonly LaneInput[], range: TsRange, order: readonly string[]): LaneLayout[] {
    const inView: number[] = [];

    for (const [i, s] of spans.entries()) {
        if (s.end >= range[0] && s.start <= range[1]) {
            inView.push(i);
        }
    }

    const packed = new Map(layoutLanes(inView.map((i) => spans[i])).map((l) => [l.name, l]));

    return order.map((name) => {
        const lane = packed.get(name);

        if (!lane) {
            return { name, rows: 1, items: [], itemRows: [] };
        }

        return { ...lane, items: lane.items.map((k) => inView[k]) };
    });
}

/** Left gutter (px) wide enough for the longest lane name at the label font, within [min, max]. */
export function laneGutterWidth(names: readonly string[], min = 76, max = 180): number {
    const longest = names.reduce((n, name) => Math.max(n, name.length), 0);

    return Math.round(Math.min(max, Math.max(min, longest * 6.2 + 18)));
}

// ─── Markers ───

export interface MarkerCluster {
    /** Pixel x of the cluster (mean of its members). */
    x: number;
    /** Indexes into the input, in time order. */
    items: number[];
}

/**
 * Merge markers whose pixel x positions are closer than `minGap` into one
 * cluster, so a dense run draws as one counted glyph instead of a pile of
 * overlapping labels. `xs` must be sorted ascending.
 */
export function clusterMarkers(xs: readonly number[], minGap: number): MarkerCluster[] {
    const out: MarkerCluster[] = [];
    let current: MarkerCluster | null = null;
    let sum = 0;
    let lastX = Number.NEGATIVE_INFINITY;

    for (const [i, x] of xs.entries()) {
        if (current && x - lastX < minGap) {
            current.items.push(i);
            sum += x;
            current.x = sum / current.items.length;
        } else {
            current = { x, items: [i] };
            sum = x;
            out.push(current);
        }

        lastX = x;
    }

    return out;
}

/**
 * Marker kinds that are on: the viewer's explicit choice wins, then `initial`
 * (the kinds a chart shows by default; every kind when it is not given).
 */
export function visibleMarkerKinds(
    kinds: readonly string[],
    initial: readonly string[] | undefined,
    overrides: Readonly<Record<string, boolean>>
): Set<string> {
    return new Set(kinds.filter((k) => overrides[k] ?? (initial ? initial.includes(k) : true)));
}

/** Clusters in view at or below which every marker keeps its full-height line. */
export const SPARSE_MARKER_CLUSTERS = 30;

export interface MarkerLinePlan {
    /** Positions in the visible marker order that get a full-height line. */
    full: number[];
    /** Pixel x of one faint line per multi-marker cluster (sparse views only). */
    faint: number[];
    /** Pixel x of a short tick at the top of each plot (dense views only). */
    ticks: number[];
}

/**
 * Which marker lines to draw. A sparse view (few clusters) keeps one full line
 * per lone marker and one faint line per cluster; a dense view draws only a
 * short tick per cluster, so thousands of markers do not stripe the plot.
 * Markers flagged in `forced` (an author's `line: true` or `lineKinds`) keep
 * their full line either way.
 */
export function planMarkerLines(
    clusters: ReadonlyArray<{ x: number; items: number[] }>,
    forced: readonly boolean[],
    sparseLimit = SPARSE_MARKER_CLUSTERS
): MarkerLinePlan {
    const sparse = clusters.length <= sparseLimit;
    const plan: MarkerLinePlan = { full: [], faint: [], ticks: [] };

    for (const cluster of clusters) {
        const pinned = cluster.items.filter((i) => forced[i]);
        plan.full.push(...pinned);

        if (!sparse) {
            plan.ticks.push(cluster.x);
        } else if (cluster.items.length === 1) {
            if (!pinned.length) {
                plan.full.push(cluster.items[0]);
            }
        } else if (pinned.length < cluster.items.length) {
            plan.faint.push(cluster.x);
        }
    }

    return plan;
}

// ─── Text ───

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/**
 * Detail text without markup that would print raw: XML or HTML-looking tags and
 * comments are removed and common entities decoded. Line breaks are kept.
 */
export function stripTags(text: string): string {
    return text
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g, " ")
        .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

/** One-paragraph plain text for a compact line: tags stripped, every run of whitespace collapsed. */
export function plainText(text: string): string {
    return stripTags(text).replace(/\s+/g, " ").trim();
}

// ─── Panels ───

export interface PanelSeriesInput {
    id: string;
    unit?: string;
    group?: string;
}

export interface PanelAxis {
    unit: string;
    side: "left" | "right";
    seriesIds: string[];
}

export interface PanelSpec {
    key: string;
    /** Group the panel belongs to (`key` adds a suffix when a group spills into a second panel). */
    group: string;
    axes: PanelAxis[];
    seriesIds: string[];
}

/** Unit used when a series has none. */
export const NO_UNIT = "value";

/**
 * Assign visible series to panels. Combined: one panel with one axis per unit,
 * at most two axes, so a third unit spills into another panel. Split: one panel
 * per `group` (default: unit), again at most two units per panel.
 */
export function assignPanels(
    series: readonly PanelSeriesInput[],
    layout: "combined" | "split",
    groupOrder: readonly string[] = []
): PanelSpec[] {
    const groups = new Map<string, PanelSeriesInput[]>();

    for (const s of series) {
        const key = layout === "combined" ? "all" : (s.group ?? s.unit ?? NO_UNIT);
        const list = groups.get(key) ?? [];
        list.push(s);
        groups.set(key, list);
    }

    const panels: PanelSpec[] = [];

    for (const [key, members] of groups) {
        const units = new Map<string, string[]>();

        for (const s of members) {
            const unit = s.unit ?? NO_UNIT;
            const ids = units.get(unit) ?? [];
            ids.push(s.id);
            units.set(unit, ids);
        }

        const entries = [...units.entries()];

        for (let i = 0; i < entries.length; i += 2) {
            const axes: PanelAxis[] = entries.slice(i, i + 2).map(([unit, ids], j) => ({
                unit,
                side: j === 0 ? "left" : "right",
                seriesIds: ids,
            }));
            panels.push({
                key: i === 0 ? key : `${key}:${i / 2}`,
                group: key,
                axes,
                seriesIds: axes.flatMap((a) => a.seriesIds),
            });
        }
    }

    return orderPanels(panels, groupOrder);
}

/**
 * Sort panels by the position of their group in `order`; groups not listed keep
 * their first-appearance order after the listed ones (the sort is stable).
 */
export function orderPanels<T extends { group: string }>(panels: readonly T[], order: readonly string[]): T[] {
    const rank = (g: string) => {
        const i = order.indexOf(g);

        return i === -1 ? order.length : i;
    };

    return [...panels].sort((a, b) => rank(a.group) - rank(b.group));
}

// ─── CSV ───

export interface CsvSeries {
    label: string;
    points: readonly TsPoint[];
}

function csvCell(s: string): string {
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Wide CSV of the points inside [t0, t1]: one row per distinct time, ISO time first, blanks where a series has no sample. */
export function toCsv(series: readonly CsvSeries[], range: TsRange): string {
    const rows = new Map<number, Array<number | null | undefined>>();

    for (const [col, s] of series.entries()) {
        for (let i = lowerBound(s.points, range[0]); i < s.points.length && s.points[i][0] <= range[1]; i += 1) {
            const [t, v] = s.points[i];
            let row = rows.get(t);

            if (!row) {
                row = new Array(series.length).fill(undefined);
                rows.set(t, row);
            }

            row[col] = v;
        }
    }

    const header = ["time", ...series.map((s) => csvCell(s.label))].join(",");
    const lines = [...rows.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, row]) => [new Date(t).toISOString(), ...row.map((v) => (v == null ? "" : String(v)))].join(","));

    return `${[header, ...lines].join("\n")}\n`;
}

// ─── Viewer state ───

export interface TsViewState {
    /** Explicit on/off per series id, only where the viewer changed it. */
    series: Record<string, boolean>;
    layout?: "combined" | "split";
    range?: TsRange;
    /** Units drawn on a log axis. */
    log: string[];
    normalize: boolean;
    /** Explicit on/off per marker kind, only where the viewer changed it. */
    markers: Record<string, boolean>;
    /** Tooltip lists every panel's values, not only the panel under the pointer. */
    allValues: boolean;
    /** Span lanes turned off. */
    hiddenLanes: string[];
    lanesOpen: boolean;
    table: boolean;
}

export function emptyViewState(): TsViewState {
    return {
        series: {},
        log: [],
        normalize: false,
        markers: {},
        allValues: false,
        hiddenLanes: [],
        lanesOpen: true,
        table: false,
    };
}

const list = (items: readonly string[]) => items.map(encodeURIComponent).join(",");

function unlist(value: string | null): string[] {
    if (!value) {
        return [];
    }

    return value.split(",").map((item) => {
        try {
            return decodeURIComponent(item);
        } catch {
            return item;
        }
    });
}

/** Compact query-string form of the viewer state (used in localStorage and the URL hash). */
export function encodeViewState(state: TsViewState): string {
    const p = new URLSearchParams();
    const on = Object.entries(state.series).map(([id, v]) => `${v ? "+" : "-"}${encodeURIComponent(id)}`);

    if (on.length) {
        p.set("s", on.join(","));
    }

    if (state.layout) {
        p.set("l", state.layout);
    }

    if (state.range) {
        p.set("r", `${Math.round(state.range[0])}~${Math.round(state.range[1])}`);
    }

    if (state.log.length) {
        p.set("g", list(state.log));
    }

    if (state.normalize) {
        p.set("n", "1");
    }

    const kinds = Object.entries(state.markers).map(([k, v]) => `${v ? "+" : "-"}${encodeURIComponent(k)}`);

    if (kinds.length) {
        p.set("k", kinds.join(","));
    }

    if (state.allValues) {
        p.set("a", "1");
    }

    if (state.hiddenLanes.length) {
        p.set("x", list(state.hiddenLanes));
    }

    if (!state.lanesOpen) {
        p.set("lc", "1");
    }

    if (state.table) {
        p.set("t", "1");
    }

    return p.toString();
}

/** Inverse of `encodeViewState`; unknown or malformed parts are ignored. */
export function decodeViewState(text: string): TsViewState {
    const p = new URLSearchParams(text);
    const state = emptyViewState();

    for (const item of unlist(p.get("s"))) {
        const sign = item[0];

        if (sign === "+" || sign === "-") {
            state.series[item.slice(1)] = sign === "+";
        }
    }

    const layout = p.get("l");

    if (layout === "combined" || layout === "split") {
        state.layout = layout;
    }

    const range = (p.get("r") ?? "").split("~").map(Number);

    if (range.length === 2 && range.every(Number.isFinite) && range[1] > range[0]) {
        state.range = [range[0], range[1]];
    }

    state.log = unlist(p.get("g"));
    state.normalize = p.get("n") === "1";
    // "m" is the older form: a list of hidden kinds.
    for (const kind of unlist(p.get("m"))) {
        state.markers[kind] = false;
    }

    for (const item of unlist(p.get("k"))) {
        const sign = item[0];

        if (sign === "+" || sign === "-") {
            state.markers[item.slice(1)] = sign === "+";
        }
    }

    state.allValues = p.get("a") === "1";
    state.hiddenLanes = unlist(p.get("x"));
    state.lanesOpen = p.get("lc") !== "1";
    state.table = p.get("t") === "1";

    return state;
}

/** Read this chart's entry (`ts.<id>=...`) out of a URL hash shared with tab ids and other charts. */
export function readHashState(hash: string, id: string): string | null {
    const key = `ts.${encodeURIComponent(id)}=`;
    const part = hashSegments(hash).find((s) => s.startsWith(key));

    if (part === undefined) {
        return null;
    }

    try {
        return decodeURIComponent(part.slice(key.length));
    } catch {
        return null;
    }
}

/** Replace this chart's entry in a hash, keeping every other segment (the tab id, other charts). */
export function writeHashState(hash: string, id: string, encoded: string): string {
    const key = `ts.${encodeURIComponent(id)}=`;
    const kept = hashSegments(hash).filter((s) => !s.startsWith(key));

    return composeHash(encoded ? [...kept, `${key}${encodeURIComponent(encoded)}`] : kept);
}
