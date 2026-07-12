/**
 * Parse a user-typed dollar amount into integer cents. `Math.round` is
 * load-bearing — `12.50 * 100` is not exactly 1250 in IEEE-754.
 * Returns null when the input is not a positive finite number.
 */
export function parseDollarsToCents(raw: string): number | null {
    const trimmed = raw.trim().replace(/[$,\s]/g, "");
    if (!trimmed) {
        return null;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }

    return Math.round(value * 100);
}

/** Format integer cents as localized currency (e.g. 1250 → "$12.50"). */
export function formatCents(cents: number, currency = "USD"): string {
    return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
    }).format(cents / 100);
}

/** Local "YYYY-MM-DD" — never UTC, so month buckets match the user's calendar. */
export function todayLocalISO(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** "YYYY-MM" month key from a "YYYY-MM-DD" day string. */
export function monthOf(day: string): string {
    return day.slice(0, 7);
}

/** Current local month key, "YYYY-MM". */
export function currentMonthKey(): string {
    return todayLocalISO().slice(0, 7);
}

/** Shift a "YYYY-MM" key by N months (negative = back). */
export function shiftMonth(monthKey: string, delta: number): string {
    const [yStr, mStr] = monthKey.split("-");
    const base = new Date(Number(yStr), Number(mStr) - 1 + delta, 1);
    const y = base.getFullYear();
    const m = String(base.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}

/** Human label for a "YYYY-MM" key, e.g. "June 2026". */
export function formatMonthLabel(monthKey: string): string {
    const [yStr, mStr] = monthKey.split("-");
    const date = new Date(Number(yStr), Number(mStr) - 1, 1);
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Short label for a "YYYY-MM-DD" day, e.g. "Jun 2". */
export function formatDayLabel(day: string): string {
    const [yStr, mStr, dStr] = day.split("-");
    const date = new Date(Number(yStr), Number(mStr) - 1, Number(dStr));
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
