import { formatLocalDate, parseSince } from "@genesiscz/utils/date";
import { parseDuration } from "@genesiscz/utils/format";

export interface TimeWindow {
    from: Date;
    to: Date;
}

/** `24h`, `7d`, `90m` back from now; else what `parseSince` reads (`HH:MM`, a date, an ISO time). */
export function parsePointInTime(value: string, now: Date): Date | null {
    const relative = /^\d+\s*[a-z]/i.test(value.trim()) ? parseDuration(value) : 0;
    if (relative > 0) {
        return new Date(now.getTime() - relative);
    }

    return parseSince(value, now);
}

export function resolveWindow({
    since = "24h",
    until,
    now = new Date(),
}: {
    since?: string;
    until?: string;
    now?: Date;
}): TimeWindow {
    const from = parsePointInTime(since, now);
    if (!from) {
        throw new Error(`--since ${since} is not a time: use 30m, 24h, 7d, HH:MM or YYYY-MM-DD`);
    }

    const to = until ? parsePointInTime(until, now) : now;
    if (!to) {
        throw new Error(`--until ${until} is not a time: use 30m, 24h, 7d, HH:MM or YYYY-MM-DD`);
    }

    // An inverted window has no days, and the readers would then scan every day file to keep nothing.
    if (from.getTime() > to.getTime()) {
        throw new Error(`--since ${since} is after --until ${until ?? "now"}`);
    }

    return { from, to };
}

/** Every local calendar day the window touches, oldest first. */
export function daysIn(window: TimeWindow): string[] {
    const days: string[] = [];
    const cursor = new Date(window.from);
    cursor.setHours(12, 0, 0, 0);

    while (formatLocalDate(cursor) <= formatLocalDate(window.to)) {
        days.push(formatLocalDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }

    return days;
}

export function inWindow(at: string, window: TimeWindow): boolean {
    const time = Date.parse(at);
    return time >= window.from.getTime() && time <= window.to.getTime();
}
