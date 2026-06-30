import Database from "better-sqlite3";

/**
 * Test-DB access for E2E seeding. The server resolves every request to this
 * user via the auth bypass, so seed rows under this id and they belong to the
 * page you load. See playwright.config.ts + src/lib/auth/requireUser.ts.
 */
export const E2E_USER_ID = "dev-user";
export const TEST_DB_PATH = process.env.SQLITE_PATH ?? "/tmp/dash-e2e/dashboard-e2e.sqlite";

export function openTestDb(): Database.Database {
    const db = new Database(TEST_DB_PATH);
    db.pragma("busy_timeout = 5000");
    return db;
}

/** Open a test-db handle, run fn, always close. */
export function withTestDb<T>(fn: (db: Database.Database) => T): T {
    const db = openTestDb();
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

/** Delete every row owned by the E2E user from the given tables (snake_case). */
export function resetTables(...tables: string[]): void {
    withTestDb((db) => {
        for (const t of tables) {
            db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(E2E_USER_ID);
        }
    });
}

let counter = 0;
export function genId(prefix = "e2e"): string {
    counter += 1;
    return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function nowIso(): string {
    return new Date().toISOString();
}

/** "YYYY-MM-DD" for a Date (defaults to today), local time. */
export function dayKey(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
