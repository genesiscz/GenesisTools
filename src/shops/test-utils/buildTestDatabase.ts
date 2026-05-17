import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

/**
 * Open an in-memory ShopsDatabase with all migrations applied.
 * Each call returns a fresh DB; close it with `db.close()` when done.
 */
export function buildTestDatabase(): ShopsDatabase {
    return new ShopsDatabase(":memory:");
}

/**
 * Run `fn` with a fresh in-memory ShopsDatabase, guaranteeing the handle
 * is closed even if `fn` throws (e.g. an assertion failure). Use this in
 * tests instead of manual `try/finally` blocks around `buildTestDatabase()`.
 */
export async function withDb<T>(fn: (db: ShopsDatabase) => Promise<T> | T): Promise<T> {
    const db = buildTestDatabase();
    try {
        return await fn(db);
    } finally {
        db.close();
    }
}
