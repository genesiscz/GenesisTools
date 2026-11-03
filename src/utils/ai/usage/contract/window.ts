import { systemTimeZone } from "@genesiscz/utils/ai/usage/series-keys";
import { epochFromWallClockInZone, partsInZone, resolveZone } from "@genesiscz/utils/timezone";
import { UsageQueryError } from "./errors";
import { parseDurationMs } from "./step";

/**
 * Raw window flags as a door receives them. `since`, `until` and `tz` are the shared grammar;
 * the rest are the older spellings each door keeps as hidden aliases (design section 5).
 */
export interface WindowFlags {
    since?: string;
    until?: string;
    tz?: string;
    /** Alias of `since` (`ai-spend series`, the proposals door). */
    from?: string;
    /** Alias of `until`. */
    to?: string;
    /** Alias of `since` (the TUI enum: 60m, 6h, 24h, 7d). `true` is commander's bare flag. */
    range?: string | boolean;
    /** Alias of `since`, in whole hours (the session lists). */
    hours?: string;
    /** Alias of `tz`. */
    timezone?: string;
}

export interface ResolvedWindow {
    from: Date;
    to: Date;
    /** IANA zone the dates and keywords were read in. */
    tz: string;
    /** What the user asked for, in their words: `since 7d`, `since 2026-10-01 until 2026-11-01`. */
    label: string;
}

export interface WindowContext {
    now: Date;
    /** The verb's default start, in the same grammar (`24h` for a series). */
    defaultSince: string;
}

/**
 * Keywords that are part of the grammar but need data a later build step adds. They refuse
 * with the step that brings them, instead of meaning something else for a while.
 */
const RESERVED_KEYWORDS: Record<string, string> = {
    reset: "--since reset (since the last reset of the binding window) arrives with tools ai usage limits attribution (build step U9).",
    cycle: "--since cycle (the current billing cycle) arrives with tools ai usage spend plans (build step U11).",
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const ACCEPTED_FORMS =
    "a duration (90m, 6h, 7d, 4w), a date YYYY-MM-DD, an ISO instant with an offset, or now | today | yesterday | week | month";

/** `--tz`, or the system zone. Accepts an IANA name and the common aliases (`cet`, `utc`). */
export function resolveTimeZone(flag: string | undefined): string {
    if (flag === undefined || flag.trim() === "") {
        return systemTimeZone();
    }

    try {
        return resolveZone(flag);
    } catch {
        throw new UsageQueryError(
            "bad-zone",
            `--tz "${flag}" is not a time zone. Pass an IANA name such as Europe/Prague.`,
            {
                given: flag,
            }
        );
    }
}

interface CivilDay {
    year: number;
    month: number;
    day: number;
}

function civilDayOf(epochMs: number, tz: string): CivilDay {
    const parts = partsInZone(epochMs, tz, { year: "numeric", month: "2-digit", day: "2-digit" });

    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** Day arithmetic on the civil calendar (`day` may overflow; `Date.UTC` carries it). */
function shiftDay(day: CivilDay, deltaDays: number): CivilDay {
    const at = new Date(Date.UTC(day.year, day.month - 1, day.day + deltaDays));

    return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

function localMidnight(day: CivilDay, tz: string): Date {
    return new Date(epochFromWallClockInZone(day.year, day.month, day.day, 0, 0, tz));
}

function keywordInstant(keyword: string, now: Date, tz: string): Date | undefined {
    if (keyword === "now") {
        return now;
    }

    const today = civilDayOf(now.getTime(), tz);

    if (keyword === "today") {
        return localMidnight(today, tz);
    }

    if (keyword === "yesterday") {
        return localMidnight(shiftDay(today, -1), tz);
    }

    if (keyword === "week") {
        // Monday start: getUTCDay() is 0 for Sunday, so Sunday steps back six days.
        const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
        return localMidnight(shiftDay(today, -((weekday + 6) % 7)), tz);
    }

    if (keyword === "month") {
        return localMidnight({ ...today, day: 1 }, tz);
    }

    return undefined;
}

/** One `--since` or `--until` value as an instant. `flag` only names the flag in an error. */
export function parseWhen(text: string, ctx: { now: Date; tz: string; flag?: string }): Date {
    const flag = ctx.flag ?? "--since";
    const value = text.trim();
    const keyword = value.toLowerCase();
    const reserved = RESERVED_KEYWORDS[keyword];

    if (reserved !== undefined) {
        throw new UsageQueryError("reserved", reserved.replace("--since", flag), { given: text });
    }

    const atKeyword = keywordInstant(keyword, ctx.now, ctx.tz);

    if (atKeyword) {
        return atKeyword;
    }

    const duration = parseDurationMs(value);

    if (duration !== undefined) {
        return new Date(ctx.now.getTime() - duration);
    }

    const date = DATE_ONLY.exec(value);

    if (date) {
        const day = { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) };
        const check = shiftDay(day, 0);

        if (check.year !== day.year || check.month !== day.month || check.day !== day.day) {
            throw new UsageQueryError("bad-window", `${flag} "${text}" is not a calendar date.`, { given: text });
        }

        return localMidnight(day, ctx.tz);
    }

    if (ISO_WITH_OFFSET.test(value)) {
        const ms = Date.parse(value);

        if (Number.isFinite(ms)) {
            return new Date(ms);
        }
    }

    if (ISO_WITHOUT_OFFSET.test(value)) {
        throw new UsageQueryError(
            "bad-window",
            `${flag} "${text}" has no offset. Add Z or an offset such as +01:00, or pass a date YYYY-MM-DD.`,
            { given: text }
        );
    }

    throw new UsageQueryError("bad-window", `${flag} "${text}" is not ${ACCEPTED_FORMS}.`, { given: text });
}

/** The one value of a flag that has aliases; two spellings at once are refused rather than ranked. */
function pickOne(spellings: Array<[string, string | undefined]>): [string, string] | undefined {
    const given = spellings.filter((entry): entry is [string, string] => entry[1] !== undefined);

    if (given.length > 1) {
        throw new UsageQueryError(
            "bad-value",
            `${given.map(([name]) => name).join(" and ")} name the same bound; pass one.`
        );
    }

    return given[0];
}

function hoursAsDuration(hours: string | undefined): string | undefined {
    if (hours === undefined) {
        return undefined;
    }

    if (!/^\d+$/.test(hours.trim()) || Number(hours) <= 0) {
        throw new UsageQueryError("bad-value", `--hours "${hours}" is not a whole number of hours.`, { given: hours });
    }

    return `${Number(hours)}h`;
}

function rangeValue(range: string | boolean | undefined): string | undefined {
    if (range === undefined || range === false) {
        return undefined;
    }

    if (range === true || range.trim() === "") {
        throw new UsageQueryError("bad-value", "--range needs a value such as 6h or 7d.");
    }

    return range;
}

/** `--since`, `--until` and `--tz` (with their aliases) as one window. */
export function resolveWindow(flags: WindowFlags, ctx: WindowContext): ResolvedWindow {
    const zone = pickOne([
        ["--tz", flags.tz],
        ["--timezone", flags.timezone],
    ]);
    const tz = resolveTimeZone(zone?.[1]);
    const since = pickOne([
        ["--since", flags.since],
        ["--from", flags.from],
        ["--range", rangeValue(flags.range)],
        ["--hours", hoursAsDuration(flags.hours)],
    ]);
    const until = pickOne([
        ["--until", flags.until],
        ["--to", flags.to],
    ]);
    const sinceText = since?.[1] ?? ctx.defaultSince;
    const from = parseWhen(sinceText, { now: ctx.now, tz, flag: since?.[0] ?? "--since" });
    const to = until ? parseWhen(until[1], { now: ctx.now, tz, flag: until[0] }) : ctx.now;

    if (from.getTime() >= to.getTime()) {
        throw new UsageQueryError(
            "bad-window",
            `The window is empty: ${from.toISOString()} (since ${sinceText}) is not before ${to.toISOString()}.`
        );
    }

    const label = until ? `since ${sinceText} until ${until[1]}` : `since ${sinceText}`;

    return { from, to, tz, label };
}
