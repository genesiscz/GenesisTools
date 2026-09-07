import type { SpendGrain } from "./types";

/**
 * The ONE bucket-key builder for spend series.
 *
 * Both producers use it — `queryUsage({ grain })` here and `buildSpendSeries`
 * in `src/ai-spend` — because the dashboard overlays their points on one axis.
 * Two implementations that disagreed by an hour would draw two lines that look
 * plausible and are not comparable, and nothing would fail.
 *
 * Buckets are LOCAL, not UTC: "what did I spend yesterday evening" is a
 * question about the wall clock. The usage day-files stay UTC-keyed; only the
 * series bucketing is zoned.
 */

export function systemTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * `Intl.DateTimeFormat` answers an unknown zone with a `RangeError`, and inside
 * the bucketing loop that surfaces as a whole query dying on its first event.
 * Producers check the zone ONCE, before any bucketing, so a bad `timeZone`
 * names itself instead of arriving as a formatter stack trace.
 */
export function isValidTimeZone(timeZone: string): boolean {
    try {
        Intl.DateTimeFormat("en-US", { timeZone });

        return true;
    } catch {
        return false;
    }
}

/**
 * One formatter per zone, reused across every event of every query.
 *
 * Constructing an `Intl.DateTimeFormat` loads locale and time-zone data, and
 * `spendBucketKey` runs once per event in both producers. On the dashboard
 * polling path that setup dominated even when every transcript was a cache hit.
 * The objects are stateless for `formatToParts`, so sharing them is safe.
 *
 * Bounded because the key is a caller-supplied zone string: the working set is
 * one or two zones, and a full reset costs one rebuild rather than unbounded
 * growth.
 */
const FORMATTER_CACHE_LIMIT = 32;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    const cached = formatters.get(timeZone);

    if (cached) {
        return cached;
    }

    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    });

    if (formatters.size >= FORMATTER_CACHE_LIMIT) {
        formatters.clear();
    }

    formatters.set(timeZone, formatter);

    return formatter;
}

/** Monday of the civil week containing `ymd`, as `YYYY-MM-DD`. */
function mondayOfDay(ymd: string): string {
    const [year, month, day] = ymd.split("-").map(Number);
    const at = new Date(Date.UTC(year, month - 1, day));
    const back = (at.getUTCDay() + 6) % 7;
    at.setUTCDate(at.getUTCDate() - back);

    return at.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` for day and week, `YYYY-MM-DDTHH` for hour,
 * `YYYY-MM-DDTHH:mm` for minute. Empty string when the timestamp is unusable,
 * which the caller drops rather than bucketing under a fake key.
 */
export function spendBucketKey(timestamp: string, grain: SpendGrain, timeZone = systemTimeZone()): string {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const parts = formatterFor(timeZone).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    const day = `${get("year")}-${get("month")}-${get("day")}`;

    if (grain === "minute") {
        return `${day}T${get("hour")}:${get("minute")}`;
    }

    if (grain === "hour") {
        return `${day}T${get("hour")}`;
    }

    if (grain === "week") {
        return mondayOfDay(day);
    }

    return day;
}
