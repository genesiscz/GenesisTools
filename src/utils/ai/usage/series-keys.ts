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

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
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
