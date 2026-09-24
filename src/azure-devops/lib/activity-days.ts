import type { WorkItemUpdate } from "@app/azure-devops/types";
import { formatDateTime } from "@genesiscz/utils/date";

/** Azure DevOps stamps the LATEST revision of a work item with this year in `revisedDate`. */
export const SENTINEL_DATE_PREFIX = "9999";

/** The day bucket for events whose real moment could not be recovered. */
export const UNDATED_DAY = "undated";

export function isSentinelDate(date: string | undefined): boolean {
    return Boolean(date?.startsWith(SENTINEL_DATE_PREFIX));
}

const DATE_FALLBACK_FIELDS = ["System.ChangedDate", "System.AuthorizedDate"];

/**
 * The moment an update happened. `revisedDate` is the END of that revision's validity window: the
 * moment the NEXT revision replaced it, and `9999-01-01` on the latest one. Reading it as the
 * change time dates every state change one revision late (a bug closed on 5.8. showed as closed on
 * 1.9., the day an automation edited a custom field) and buckets the latest revision on `9999`.
 * The same update carries the real moment in `System.ChangedDate`, with `System.AuthorizedDate` as
 * a fallback; a real `revisedDate` is the last resort, and an update with none of them is
 * genuinely undated and says so rather than guessing.
 */
export function resolveUpdateDate(update: WorkItemUpdate): string {
    for (const field of DATE_FALLBACK_FIELDS) {
        const value = update.fields?.[field]?.newValue;

        if (typeof value === "string" && value.length > 0 && !isSentinelDate(value)) {
            return value;
        }
    }

    if (update.revisedDate && !isSentinelDate(update.revisedDate)) {
        return update.revisedDate;
    }

    return "";
}

/**
 * One end of a `--from` / `--to` window, as a moment.
 *
 * A bare `YYYY-MM-DD` is a calendar day the way the person typing it means it: in their own
 * timezone. `new Date("2026-09-14")` instead parses that form as UTC midnight, and west of
 * Greenwich that is already the previous local day, so clamping it with `setHours(23, 59, …)`
 * produced the end of 13 September for a `--to` of the 14th and silently dropped the whole day
 * asked for. Verified: under `TZ=America/Chicago` the old form yields `Sun Sep 13 2026 23:59:59`.
 * A value that carries its own time is left to `Date`, which is the right reading of an explicit
 * timestamp.
 */
export function parseDayBoundary(value: string, { endOfDay = false }: { endOfDay?: boolean } = {}): Date {
    const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());

    if (!bare) {
        return new Date(value);
    }

    const year = Number(bare[1]);
    const month = Number(bare[2]);
    const day = Number(bare[3]);
    const at = new Date(year, month - 1, day);

    // The numeric constructor ROLLS OVER instead of failing: `new Date(2026, 12, 45)` is
    // 14 February 2027. `new Date("2026-13-45")` was an Invalid Date, which the callers already
    // report as a bad `--from`, so the round trip keeps that rejection rather than silently
    // answering for a different window.
    if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) {
        return new Date(Number.NaN);
    }

    if (endOfDay) {
        at.setHours(23, 59, 59, 999);
    }

    return at;
}

/**
 * Whether the window's end precedes its start. Such a window matches nothing, and "nothing" is
 * indistinguishable from "this person was never named" once it reaches the screen. A swapped pair
 * of dates is an ordinary typing mistake, so it is worth saying out loud rather than answering
 * with a confident empty result.
 */
export function isInvertedWindow(from?: Date, to?: Date): boolean {
    return Boolean(from && to && to.getTime() < from.getTime());
}

/**
 * Whether an event's moment falls inside the requested window.
 *
 * An event whose date could not be recovered is EXCLUDED as soon as a bound exists: the caller
 * narrowed the query on purpose, and an unknown moment cannot be shown to satisfy it. With no
 * bound it is kept, which is what the `undated` bucket is for.
 *
 * This is the other half of the sentinel fix. Resolving `9999-01-01` to the real moment stopped
 * the far-future day row AND stopped that revision matching every window, but only where a
 * fallback field existed. Where none does, `resolveUpdateDate` returns `""`, and `new Date("")`
 * is an Invalid Date that compares `false` against BOTH `<` and `>`. So the undated update sailed
 * through both bounds exactly as the sentinel had, just wearing a different value.
 */
export function withinDayWindow(date: string, from?: Date, to?: Date): boolean {
    if (!from && !to) {
        return true;
    }

    const at = new Date(date);

    if (Number.isNaN(at.getTime())) {
        return false;
    }

    if (from && at < from) {
        return false;
    }

    return !(to && at > to);
}

/**
 * The calendar day as the person who typed the bound sees it.
 *
 * `parseDayBoundary` answers in LOCAL time, so `toISOString().slice(0, 10)` reports the day either
 * side of the one that was asked for: under `TZ=Europe/Prague` a `--from` of 2026-09-14 printed
 * 2026-09-13, and under `TZ=America/Chicago` a `--to` of 2026-09-14 printed 2026-09-15.
 */
export function localDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${date.getFullYear()}-${month}-${day}`;
}

export interface DatedEvent {
    date: string;
}

export interface EventDay<T extends DatedEvent> {
    date: string;
    dayName: string;
    events: T[];
}

function eventTime(event: DatedEvent): number {
    const parsed = Date.parse(event.date);

    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function dayKey(event: DatedEvent): string {
    if (!event.date || isSentinelDate(event.date) || Number.isNaN(Date.parse(event.date))) {
        return UNDATED_DAY;
    }

    return event.date.slice(0, 10);
}

function compareDayKeys(a: string, b: string): number {
    if (a === UNDATED_DAY) {
        return 1;
    }

    if (b === UNDATED_DAY) {
        return -1;
    }

    return a.localeCompare(b);
}

/**
 * Group events into day rows, oldest first. Anything without a usable date lands in one explicit
 * `undated` bucket at the end instead of becoming a day of its own.
 */
export function groupEventsByDay<T extends DatedEvent>(events: T[]): EventDay<T>[] {
    const sorted = [...events].sort((a, b) => eventTime(a) - eventTime(b));
    const byDay = new Map<string, T[]>();

    for (const event of sorted) {
        const key = dayKey(event);
        const bucket = byDay.get(key);

        if (bucket) {
            bucket.push(event);
            continue;
        }

        byDay.set(key, [event]);
    }

    return [...byDay.entries()]
        .sort(([a], [b]) => compareDayKeys(a, b))
        .map(([date, dayEvents]) => ({
            date,
            dayName: date === UNDATED_DAY ? "no date recorded" : formatDateTime(date, { absolute: "weekday" }),
            events: dayEvents,
        }));
}

/** How many real calendar days a grouping covers. The undated bucket is not a day. */
export function realDayCount(days: EventDay<DatedEvent>[]): number {
    return days.filter((day) => day.date !== UNDATED_DAY).length;
}
