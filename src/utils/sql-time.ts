/**
 * Browser-safe time/date helpers used by SQLite-backed tools.
 *
 * Keep this file logger-free so it can be imported by browser/UI bundles
 * without dragging Node-only dependencies (pino, fs, …) along.
 */

/**
 * SQL fragment that produces a UTC ISO-8601 timestamp with milliseconds and a Z suffix
 * (e.g. `2026-04-27T18:10:00.000Z`). Use this in `DEFAULT (...)` clauses or inline updates
 * so JS `new Date(s)` parses the value as UTC without ambiguity.
 *
 * Example:
 * ```ts
 * import { SQL_NOW_UTC } from "@app/utils/sql-time";
 * db.exec(`CREATE TABLE foo (created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}))`);
 * db.run(`UPDATE foo SET updated_at = ${SQL_NOW_UTC} WHERE id = ?`, [id]);
 * ```
 */
export const SQL_NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Returns the current UTC time as an ISO-8601 string (matches `SQL_NOW_UTC` shape). */
export function nowUtcIso(): string {
    return new Date().toISOString();
}

/**
 * Parse a date string from SQLite (`datetime('now')` legacy, no timezone marker)
 * OR from JS `Date.toISOString()` (UTC, has 'Z'). Always returns a UTC-anchored Date.
 *
 * Returns null if the input is empty or unparseable.
 */
export function parseSqliteOrIsoDate(value: string | null | undefined): Date | null {
    if (!value) {
        return null;
    }

    if (value.includes("T") || value.endsWith("Z")) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(`${value.replace(" ", "T")}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
