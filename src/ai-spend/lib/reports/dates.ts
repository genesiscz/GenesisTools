import type { PeriodGrain } from "./types";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_DAY = /^\d{8}$/;

export function systemTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(timeZone: string): boolean {
    try {
        Intl.DateTimeFormat("en-US", { timeZone });
        return true;
    } catch {
        return false;
    }
}

/** Accept ccusage `YYYY-MM-DD` or `YYYYMMDD`. */
export function parseDayArg(raw: string | undefined): string | undefined {
    if (!raw) {
        return undefined;
    }

    const trimmed = raw.trim();

    if (COMPACT_DAY.test(trimmed)) {
        const day = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
        return isValidIsoDay(day) ? day : undefined;
    }

    if (ISO_DAY.test(trimmed) && isValidIsoDay(trimmed)) {
        return trimmed;
    }

    return undefined;
}

function isValidIsoDay(day: string): boolean {
    const parsed = new Date(`${day}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function zonedDay(timestamp: string, timeZone: string): string {
    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Local hour bucket, `YYYY-MM-DDTHH`. The finest grain the transcript series
 * offers: agents stamp events to the second, but a per-minute line drawn from
 * turn-level records is noise, not signal.
 */
export function hourKey(timestamp: string, timeZone: string): string {
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
        hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";

    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}`;
}

export function addDays(ymd: string, days: number): string {
    const [year, month, day] = ymd.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return next.toISOString().slice(0, 10);
}

/** Monday of the civil week that contains `ymd`. */
export function mondayOf(ymd: string): string {
    const [year, month, day] = ymd.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const back = (weekday + 6) % 7;
    return addDays(ymd, -back);
}

export function periodKey(ymd: string, grain: PeriodGrain): string {
    if (grain === "monthly") {
        return ymd.slice(0, 7);
    }

    if (grain === "weekly") {
        return mondayOf(ymd);
    }

    return ymd;
}

export function periodFieldName(grain: PeriodGrain): "date" | "week" | "month" {
    if (grain === "weekly") {
        return "week";
    }

    if (grain === "monthly") {
        return "month";
    }

    return "date";
}

export function inDayWindow(ymd: string, sinceDay?: string, untilDay?: string): boolean {
    if (!ymd) {
        return false;
    }

    if (sinceDay && ymd < sinceDay) {
        return false;
    }

    if (untilDay && ymd > untilDay) {
        return false;
    }

    return true;
}

/** `--last N` lowers the since bound so the most recent N periods (including today) are kept. */
export function lastSinceDay(grain: PeriodGrain, count: number, today: string): string {
    const n = Math.max(1, count);

    if (grain === "daily") {
        return addDays(today, -(n - 1));
    }

    if (grain === "weekly") {
        return addDays(mondayOf(today), -7 * (n - 1));
    }

    const [year, month] = today.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - n, 1));
    return start.toISOString().slice(0, 10);
}

/** `Nd` relative to the civil day of `now` in `timeZone`. */
export function resolveRelativeSince(raw: string, now: Date, timeZone: string): string | undefined {
    const match = raw.trim().match(/^(\d+)d$/);

    if (!match) {
        return undefined;
    }

    const today = zonedDay(now.toISOString(), timeZone);

    if (!today) {
        return undefined;
    }

    return addDays(today, -Number.parseInt(match[1], 10));
}

export function parseLast(raw: string | undefined): number | undefined {
    if (!raw) {
        return undefined;
    }

    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function parseCostMode(raw: string | undefined): "auto" | "calculate" | "display" {
    if (raw === "calculate" || raw === "display" || raw === "auto") {
        return raw;
    }

    return "auto";
}
