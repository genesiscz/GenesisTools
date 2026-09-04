import type { SpendGrain } from "@app/dev-dashboard/contract/ai-accounts";
import { parseStringArray } from "./persisted-state";

export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "custom";

export const RANGE_PRESETS: ReadonlyArray<{ value: RangePreset; label: string; minutes: number | null }> = [
    { value: "1h", label: "1h", minutes: 60 },
    { value: "6h", label: "6h", minutes: 360 },
    { value: "24h", label: "24h", minutes: 1440 },
    { value: "7d", label: "7d", minutes: 10080 },
    { value: "30d", label: "30d", minutes: 43200 },
    { value: "custom", label: "custom", minutes: null },
];

export interface TimeRange {
    preset: RangePreset;
    /** ISO, only read when `preset` is `custom`. */
    from?: string;
    to?: string;
}

export interface AiAccountsFilters {
    /** Plugin ids. Empty means every provider. */
    providers: string[];
    /** Account ids. Empty means every account of the selected providers. */
    accountIds: string[];
    range: TimeRange;
}

export const DEFAULT_FILTERS: AiAccountsFilters = {
    providers: [],
    accountIds: [],
    range: { preset: "7d" },
};

export interface ResolvedRange {
    fromMs: number;
    toMs: number;
    minutes: number;
    /** Human window label, for the widget header. */
    label: string;
}

function isPreset(value: unknown): value is RangePreset {
    return RANGE_PRESETS.some((p) => p.value === value);
}

export function parseFilters(raw: unknown): AiAccountsFilters | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }

    const record = raw as Record<string, unknown>;
    const providers = parseStringArray(record.providers);
    const accountIds = parseStringArray(record.accountIds);
    const range = record.range;

    if (!providers || !accountIds || typeof range !== "object" || range === null) {
        return null;
    }

    const rangeRecord = range as Record<string, unknown>;

    if (!isPreset(rangeRecord.preset)) {
        return null;
    }

    return {
        providers,
        accountIds,
        range: {
            preset: rangeRecord.preset,
            from: typeof rangeRecord.from === "string" ? rangeRecord.from : undefined,
            to: typeof rangeRecord.to === "string" ? rangeRecord.to : undefined,
        },
    };
}

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

export function formatLocalStamp(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Turn a preset or custom range into concrete bounds. `now` is injected so tests never read the clock. */
export function resolveRange(range: TimeRange, now: number): ResolvedRange {
    const preset = RANGE_PRESETS.find((p) => p.value === range.preset);

    if (preset?.minutes !== null && preset?.minutes !== undefined) {
        const fromMs = now - preset.minutes * 60_000;
        return {
            fromMs,
            toMs: now,
            minutes: preset.minutes,
            label: `last ${preset.label}, ${formatLocalStamp(fromMs)} to ${formatLocalStamp(now)}`,
        };
    }

    const fromParsed = range.from ? new Date(range.from).getTime() : Number.NaN;
    const toParsed = range.to ? new Date(range.to).getTime() : Number.NaN;
    const toMs = Number.isNaN(toParsed) ? now : Math.min(toParsed, now);
    const fromMs = Number.isNaN(fromParsed) || fromParsed >= toMs ? toMs - 7 * 24 * 60 * 60_000 : fromParsed;
    const minutes = Math.max(1, Math.round((toMs - fromMs) / 60_000));

    return {
        fromMs,
        toMs,
        minutes,
        label: `${formatLocalStamp(fromMs)} to ${formatLocalStamp(toMs)}`,
    };
}

/**
 * How far a window end may move before it counts as a new window.
 *
 * Every query key on the page is built from the window bounds, so a `to` taken
 * straight from `Date.now()` mints a new key on every tick and nothing is ever
 * served from cache: an idle 7-day page issued six spend requests over four
 * windows a minute, and an idle 30-day page paid for a fresh transcript scan
 * each time (sweep 2026-09-04, N1). The step scales with the window because a
 * minute matters on an hour of data and means nothing on a month of it.
 */
export function windowStepMs(minutes: number): number {
    if (minutes <= 180) {
        return 60_000;
    }

    if (minutes <= 3 * 1440) {
        return 300_000;
    }

    return 900_000;
}

/**
 * The window a query should ask for: the same bounds until the clock crosses the
 * next step, so a re-render and a refetch reuse one cache entry. The end is
 * snapped DOWN, never up, so a window never reaches into the future.
 */
export function resolveStableRange(range: TimeRange, nowMs: number): ResolvedRange {
    const step = windowStepMs(resolveRange(range, nowMs).minutes);
    return resolveRange(range, Math.floor(nowMs / step) * step);
}

/** The chart grain that keeps a window readable: about 60 to 200 points. */
export function grainForMinutes(minutes: number): SpendGrain {
    if (minutes <= 180) {
        return "minute";
    }

    if (minutes <= 3 * 1440) {
        return "hour";
    }

    if (minutes <= 120 * 1440) {
        return "day";
    }

    return "week";
}
