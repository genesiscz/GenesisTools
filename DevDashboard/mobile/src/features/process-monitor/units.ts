/**
 * Pure formatters for the Process Monitor screen. Reimplemented locally (NOT imported from `@app/*`)
 * so the RN bundle never drags web/server code in. Pure logic only — runs under `bun:test`.
 */

export const DASH = "—";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Memory in `### MB` (under 1 GB) or `#.# GB` (≥ 1 GB); em-dash on null/NaN. */
export function mb(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
        return DASH;
    }

    if (bytes >= GB) {
        return `${(bytes / GB).toFixed(1)} GB`;
    }

    return `${Math.round(bytes / MB)} MB`;
}

/** Human uptime from ms: `#h #m` (≥ 1 h), `#m` (≥ 1 min), else `#s`; em-dash on null/NaN. */
export function uptime(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) {
        return DASH;
    }

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m`;
    }

    return `${seconds}s`;
}

/** CPU percentage rounded to a whole number with a `%` suffix; em-dash on null/NaN. */
export function cpu(pct: number | null | undefined): string {
    if (pct === null || pct === undefined || Number.isNaN(pct)) {
        return DASH;
    }

    return `${Math.round(pct)}%`;
}
