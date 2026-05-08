import { ShopsDatabase } from "../db/ShopsDatabase";

/**
 * Open an in-memory ShopsDatabase with all migrations applied.
 * Each call returns a fresh DB; close it with `db.close()` when done.
 */
export function buildTestDatabase(): ShopsDatabase {
    return new ShopsDatabase(":memory:");
}
