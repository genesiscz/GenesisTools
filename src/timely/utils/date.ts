/**
 * Get the date range for a given month (YYYY-MM)
 * @param month - Month in YYYY-MM format
 * @returns Object with since (first day) and upto (last day)
 */
export function getMonthDateRange(month: string): { since: string; upto: string } {
    const [year, monthNum] = month.split("-").map(Number);

    // First day of month
    const since = `${year}-${String(monthNum).padStart(2, "0")}-01`;

    // Last day of month
    const lastDay = new Date(year, monthNum, 0).getDate();
    const upto = `${year}-${String(monthNum).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    return { since, upto };
}

/**
 * Format total seconds as "Xh Ym"
 */
export function formatDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

/**
 * Get all dates in a month
 * @param month - Month in YYYY-MM format
 * @returns Array of dates in YYYY-MM-DD format
 */
export function getDatesInMonth(month: string): string[] {
    const { since, upto } = getMonthDateRange(month);
    const dates: string[] = [];

    const start = new Date(since);
    const end = new Date(upto);

    const current = new Date(start);
    while (current <= end) {
        dates.push(current.toISOString().split("T")[0]);
        current.setDate(current.getDate() + 1);
    }

    return dates;
}
