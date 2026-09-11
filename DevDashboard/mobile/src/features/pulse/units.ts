/**
 * Pure value formatters for the Pulse screen. Reimplemented locally (NOT imported from `@app/*`)
 * so the RN bundle never drags web/server utils in. All return the em-dash `DASH` for missing
 * data, matching the web Pulse UI's null handling.
 */

export const DASH = "—";

/** One-decimal percent with a `%` suffix; null → em dash. */
export function pct(value: number | null): string {
    if (value === null) {
        return DASH;
    }

    return `${value.toFixed(1)}%`;
}

/** Rounded integer percent of used/total; null or zero-total → em dash. */
export function ratioPct(used: number | null, total: number | null): string {
    if (used === null || !total) {
        return DASH;
    }

    return `${Math.round((used / total) * 100)}%`;
}

/** Bytes → one-decimal GB; null → em dash. */
export function gb(bytes: number | null): string {
    if (bytes === null) {
        return DASH;
    }

    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** ISO string → 24h `HH:MM` (optionally in a timezone); null/invalid → em dash. */
export function formatClock(iso: string | null, timeZone?: string): string {
    if (!iso) {
        return DASH;
    }

    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return DASH;
    }

    return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        ...(timeZone ? { timeZone } : {}),
    }).format(date);
}
