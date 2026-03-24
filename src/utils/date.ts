/**
 * Shared date utilities — browser-safe (no Node.js imports at top level).
 * For locale detection (requires Node.js), see ./date-locale.ts.
 */

let _resolveLocale: (() => string) | undefined;

function resolveLocale(override?: string): string {
    if (override) {
        return override;
    }

    if (!_resolveLocale) {
        // Lazy require so Vite won't bundle node:child_process into client code.
        _resolveLocale = (require("./date-locale") as { getSystemLocale: () => string }).getSystemLocale;
    }

    return _resolveLocale();
}

// ============================================
// Locale-Aware Display Formatting
// ============================================

export type AbsoluteFormat =
    | "date" // "21. 3. 2026" (locale)
    | "time" // "20:53" (locale)
    | "datetime" // "21. 3. 2026 20:53" (locale)
    | "date-long" // "Saturday, 21 March 2026" (locale)
    | "date-short" // "21. 3." or "3/21" (locale, no year)
    | "datetime-long" // "Saturday, 21 March 2026, 20:53" (locale)
    | "weekday" // "Saturday" (locale)
    | "month-day" // "Mar 21" or "21. bře" (locale)
    | "time-seconds"; // "20:53:12" (locale)

export type RelativeFormat =
    | "this-day" // relative only within today, absolute otherwise
    | "two-days" // relative within 48h, absolute otherwise
    | "always-relative-short" // "2h ago", "3d ago"
    | "always-relative-long"; // "2 hours 30 minutes ago", shows seconds if < 1 min

export interface FormatDateTimeOptions {
    /** Show relative time. Controls the threshold for relative display. */
    relative?: RelativeFormat;
    /** Show absolute time. Controls the detail level. Default: "datetime" */
    absolute?: AbsoluteFormat;
    /**
     * When both relative and absolute are requested, which comes first?
     * Default: "absolute" → "22. 3. 2026, 20:04 (1h ago)"
     * "relative" → "1h ago (22. 3. 2026, 20:04)"
     */
    first?: "absolute" | "relative";
    /** Override locale (default: system locale via getSystemLocale()) */
    locale?: string;
}

/**
 * Format a date/time for CLI display using system locale.
 *
 * - `{ absolute: "datetime" }` → "21. 3. 2026 20:53" (locale-formatted)
 * - `{ relative: "two-days" }` → "2 hours ago" or absolute if older
 * - `{ relative: "two-days", absolute: "datetime" }` → "22. 3. 2026, 20:53 (2h ago)"
 * - `{ relative: "two-days", absolute: "datetime", first: "relative" }` → "2h ago (22. 3. 2026, 20:53)"
 * - No options → defaults to `{ absolute: "datetime" }`
 */
export function formatDateTime(date: Date | string | number, options: FormatDateTimeOptions = {}): string {
    const d = date instanceof Date ? date : new Date(date);
    const locale = resolveLocale(options.locale);
    const now = new Date();

    const hasRelative = options.relative !== undefined;
    const hasAbsolute = options.absolute !== undefined;

    if (!hasRelative && !hasAbsolute) {
        return absoluteFormat(d, "datetime", locale);
    }

    const relativeStr = hasRelative ? relativeFormat(d, now, options.relative!) : null;
    const absoluteStr = hasAbsolute ? absoluteFormat(d, options.absolute!, locale) : null;

    if (relativeStr && absoluteStr) {
        const first = options.first ?? "absolute";

        if (first === "relative") {
            return `${relativeStr} (${absoluteStr})`;
        }

        return `${absoluteStr} (${relativeStr})`;
    }

    if (hasRelative && !hasAbsolute) {
        return relativeStr ?? absoluteFormat(d, "datetime", locale);
    }

    return absoluteStr ?? absoluteFormat(d, "datetime", locale);
}

// ---- Absolute ----

const ABSOLUTE_OPTIONS: Record<AbsoluteFormat, Intl.DateTimeFormatOptions> = {
    date: { year: "numeric", month: "numeric", day: "numeric" },
    time: { hour: "2-digit", minute: "2-digit" },
    datetime: {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    },
    "date-long": { weekday: "long", year: "numeric", month: "long", day: "numeric" },
    "date-short": { month: "numeric", day: "numeric" },
    "datetime-long": {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    },
    weekday: { weekday: "long" },
    "month-day": { month: "short", day: "numeric" },
    "time-seconds": { hour: "2-digit", minute: "2-digit", second: "2-digit" },
};

function absoluteFormat(date: Date, format: AbsoluteFormat, locale: string): string {
    return new Intl.DateTimeFormat(locale, ABSOLUTE_OPTIONS[format]).format(date);
}

// ---- Relative ----

function relativeFormat(date: Date, now: Date, mode: RelativeFormat): string | null {
    const diffMs = now.getTime() - date.getTime();
    const isFuture = diffMs < 0;
    const absDiffMs = Math.abs(diffMs);

    const seconds = Math.floor(absDiffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const suffix = isFuture ? "from now" : "ago";

    switch (mode) {
        case "this-day": {
            if (!isSameCalendarDay(date, now)) {
                return null;
            }

            break;
        }

        case "two-days": {
            if (absDiffMs > 48 * 60 * 60 * 1000) {
                return null;
            }

            break;
        }

        case "always-relative-short":
        case "always-relative-long":
            break;
    }

    if (mode === "always-relative-long") {
        return relativeFormatLong(days, hours, minutes, seconds, suffix);
    }

    return relativeFormatShort(days, hours, minutes, seconds, suffix);
}

function relativeFormatLong(days: number, hours: number, minutes: number, seconds: number, suffix: string): string {
    if (seconds < 60) {
        return `${seconds} second${seconds !== 1 ? "s" : ""} ${suffix}`;
    }

    if (minutes < 60) {
        const remSec = seconds % 60;
        const parts = [`${minutes} minute${minutes !== 1 ? "s" : ""}`];

        if (remSec > 0) {
            parts.push(`${remSec} second${remSec !== 1 ? "s" : ""}`);
        }

        return `${parts.join(" ")} ${suffix}`;
    }

    if (hours < 24) {
        const remMin = minutes % 60;
        const parts = [`${hours} hour${hours !== 1 ? "s" : ""}`];

        if (remMin > 0) {
            parts.push(`${remMin} minute${remMin !== 1 ? "s" : ""}`);
        }

        return `${parts.join(" ")} ${suffix}`;
    }

    const remHours = hours % 24;
    const parts = [`${days} day${days !== 1 ? "s" : ""}`];

    if (remHours > 0) {
        parts.push(`${remHours} hour${remHours !== 1 ? "s" : ""}`);
    }

    return `${parts.join(" ")} ${suffix}`;
}

function relativeFormatShort(days: number, hours: number, minutes: number, seconds: number, suffix: string): string {
    if (seconds < 60) {
        return `${seconds}s ${suffix}`;
    }

    if (minutes < 60) {
        return `${minutes}m ${suffix}`;
    }

    if (hours < 24) {
        return `${hours}h ${suffix}`;
    }

    return `${days}d ${suffix}`;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ============================================
// Date Parsing & Calendar Utilities
// ============================================

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
