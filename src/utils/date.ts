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
