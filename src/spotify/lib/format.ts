/**
 * Number formatting shared by the terminal renderers and the dashboard.
 *
 * Kept free of colour and of any node import so the browser bundle can use the exact same
 * functions — a percentage that reads 4.2% in the terminal and 4.19% in the dashboard is
 * the kind of discrepancy that makes people distrust both.
 */
export const int = (n: number) => Math.round(n).toLocaleString("en-US");

export const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;

export function hours(ms: number): string {
    const h = ms / 3600000;
    if (h >= 100) {
        return `${Math.round(h).toLocaleString("en-US")}h`;
    }

    return `${h.toFixed(1)}h`;
}

/** Global stream counts run to ten digits; tables and axes need them short. */
export function compact(n: number): string {
    if (n >= 1e9) {
        return `${(n / 1e9).toFixed(1)}B`;
    }

    if (n >= 1e6) {
        return `${(n / 1e6).toFixed(1)}M`;
    }

    if (n >= 1e3) {
        return `${(n / 1e3).toFixed(0)}k`;
    }

    return String(Math.round(n));
}
