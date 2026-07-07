/** Fixed-width ISO-8601 (ms precision). Lexicographic order == chronological,
 *  so TEXT columns can be compared/sorted directly in SQLite. */
export function nowIso(): string {
    return new Date().toISOString();
}
