/**
 * Pure value formatters for the weather card. Reimplemented locally (NOT imported from `@app/*` or
 * even pulse — feature folders own their formatters so parallel agents never collide on a shared
 * file). All return the em-dash `DASH` for missing data, matching the web weather UI.
 */

export const DASH = "—";

/** Temp in °C, one decimal; null → em dash. */
export function temp(value: number | null): string {
    if (value === null) {
        return DASH;
    }

    return `${value.toFixed(1)}°C`;
}

/** ISO string → 24h `HH:MM`; null/invalid → em dash. */
export function clock(iso: string | null): string {
    if (!iso) {
        return DASH;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return DASH;
    }

    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
