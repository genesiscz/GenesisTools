/**
 * Shared date utilities for CLI tools.
 */

/**
 * Parse a date string (e.g. "YYYY-MM-DD") and throw on invalid input.
 */
export function parseDate(value: string): Date {
    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid date: ${value}`);
    }

    return d;
}

/**
 * Get the date range for a given month.
 * @param month - Month in "YYYY-MM" format
 * @returns Object with `since` (first day) and `upto` (last day) in "YYYY-MM-DD" format
 */
export function getMonthDateRange(month: string): { since: string; upto: string } {
    const [year, monthNum] = month.split("-").map(Number);

    const since = `${year}-${String(monthNum).padStart(2, "0")}-01`;
    const lastDay = new Date(year, monthNum, 0).getDate();
    const upto = `${year}-${String(monthNum).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    return { since, upto };
}

/**
 * Get all dates in a month as an array of "YYYY-MM-DD" strings.
 * @param month - Month in "YYYY-MM" format
 */
/**
 * Format a Date to "YYYY-MM-DD".
 */
export function formatDate(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Get the ISO week (Mon–Sun) range for a given date.
 */
export function getWeekRange(date: Date): { start: Date; end: Date } {
    const d = new Date(date);
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const start = new Date(d);
    start.setUTCDate(diff);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { start, end };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Add one day to a "YYYY-MM-DD" date string.
 */
export function addDay(date: string): string {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + 1);
    return formatDate(d);
}

/**
 * Subtract one day from a "YYYY-MM-DD" date string.
 */
export function subtractDay(date: string): string {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() - 1);
    return formatDate(d);
}

/**
 * Get all days in a date range as labeled entries.
 * Start is inclusive, finish is exclusive (standard half-open interval).
 * Format: "YYYY-MM-DD".
 */
export function getDaysInPeriod(periodStart: string, periodFinish: string): Array<{ label: string; date: string }> {
    const start = new Date(periodStart);
    const finish = new Date(periodFinish);
    const days: Array<{ label: string; date: string }> = [];
    const current = new Date(start);

    while (current < finish) {
        const dow = current.getUTCDay();
        days.push({ label: `${DAY_NAMES[dow]} ${current.getUTCDate()}`, date: formatDate(current) });
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return days;
}

/**
 * Convert minutes to seconds.
 */
export function minutesToSeconds(minutes: number): number {
    return minutes * 60;
}

/**
 * Build a per-day value array for every day in a half-open [start, finish) period.
 * Returns one entry per day with date string and computed value.
 */
export function buildDailyValues<T>(
    periodStart: string,
    periodFinish: string,
    getValue: (date: string) => T
): Array<{ date: string; iso: string; value: T }> {
    const result: Array<{ date: string; iso: string; value: T }> = [];
    const start = new Date(periodStart);
    const end = new Date(periodFinish);
    const current = new Date(start);

    while (current < end) {
        const dateStr = formatDate(current);
        result.push({ date: dateStr, iso: `${dateStr}T00:00:00`, value: getValue(dateStr) });
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return result;
}

export function getDatesInMonth(month: string): string[] {
    const { since, upto } = getMonthDateRange(month);
    const dates: string[] = [];

    const start = new Date(since);
    const end = new Date(upto);

    const current = new Date(start);
    while (current <= end) {
        dates.push(current.toISOString().split("T")[0]);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
}
