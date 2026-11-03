import { aiUsageCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { UsageQueryError } from "./errors";

const UNIT_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};

const DURATION = /^(\d+)(s|m|h|d|w)$/;

/**
 * `30s`, `90m`, `6h`, `24h`, `7d`, `4w` as milliseconds; anything else is undefined. A duration
 * is a fixed length: `7d` is 168 hours even across a DST change. `m` is minutes, never months.
 */
const MAX_DATE_MS = 8.64e15;

export function parseDurationMs(text: string): number | undefined {
    const match = DURATION.exec(text.trim().toLowerCase());

    if (!match) {
        return undefined;
    }

    const count = Number(match[1]);
    const unit = UNIT_MS[match[2]];

    if (!Number.isSafeInteger(count) || count <= 0 || unit === undefined) {
        return undefined;
    }

    const ms = count * unit;

    // A Date holds at most 8.64e15 ms either side of 1970: a longer span names no instant.
    return ms <= MAX_DATE_MS ? ms : undefined;
}

/**
 * Points per series that `--step auto` keeps. 720 divides every preset range into whole
 * seconds (60m into 5 s, 6h into 30 s, 24h into 2 min, 7d into 14 min, 30d into 1 h), so a bin
 * starts on a clock minute and the TUI, the web page and the CLI draw the same curve.
 */
export const SERIES_MAX_POINTS = 720;

/**
 * THE default bin width of a limits series, for every door: the TUI history view, the
 * dev-dashboard route and `tools ai usage limits series`. Rounded UP, first to the cap and then
 * to a whole second, so a range never holds more than `SERIES_MAX_POINTS` bins. 0 (every row)
 * when the range is not usable.
 */
export function autoSeriesStepMs(from: string | Date, to: string | Date): number {
    const span = instantMs(to) - instantMs(from);

    if (!Number.isFinite(span) || span <= 0) {
        return 0;
    }

    return Math.ceil(span / SERIES_MAX_POINTS / 1_000) * 1_000;
}

function instantMs(value: string | Date): number {
    return typeof value === "string" ? Date.parse(value) : value.getTime();
}

export type SeriesStep = { kind: "auto" } | { kind: "raw" } | { kind: "fixed"; ms: number };

const CALENDAR_STEPS = new Set(["hour", "day", "week"]);

/** `--step auto | raw | <duration>`. Omitted is `auto`. */
export function parseStep(text: string | undefined): SeriesStep {
    if (text === undefined) {
        return { kind: "auto" };
    }

    const value = text.trim().toLowerCase();

    if (value === "auto") {
        return { kind: "auto" };
    }

    if (value === "raw") {
        return { kind: "raw" };
    }

    if (CALENDAR_STEPS.has(value)) {
        throw new UsageQueryError(
            "reserved",
            `--step ${value} is a calendar step in --tz, which this verb does not take; calendar periods are ` +
                `${aiUsageCommand("spend", "daily|weekly|monthly")}. Use a fixed step such as 1h or 1d.`,
            { given: text }
        );
    }

    const ms = parseDurationMs(value);

    if (ms === undefined) {
        throw new UsageQueryError("bad-step", `--step "${text}" is not auto, raw or a duration such as 30s, 5m, 1h.`, {
            given: text,
        });
    }

    return { kind: "fixed", ms };
}

/** The bin width in ms for a window; 0 asks for every row. */
export function resolveStepMs(step: SeriesStep, window: { from: Date; to: Date }): number {
    if (step.kind === "raw") {
        return 0;
    }

    if (step.kind === "fixed") {
        return step.ms;
    }

    return autoSeriesStepMs(window.from, window.to);
}
