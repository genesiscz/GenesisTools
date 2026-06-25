import type { Database } from "bun:sqlite";
import { logger } from "@app/logger";
import {
    ensureExtensionCapableSQLiteCore,
    getSqliteVecLoaderState,
    HOMEBREW_SQLITE_PATHS,
    resetSqliteVecLoaderState,
} from "./sqlite-vec-bootstrap";

export { HOMEBREW_SQLITE_PATHS };

const state = getSqliteVecLoaderState;

/**
 * Try to swap bun:sqlite to a build that supports extension loading.
 * On macOS, the default bun-bundled sqlite3 does not support loadExtension().
 * This is a best-effort call -- the actual load() call will be the real test.
 *
 * MUST be called BEFORE any Database instance is created. Call this early in
 * your program entry point if you plan to use sqlite-vec.
 */
export function ensureExtensionCapableSQLite(): void {
    ensureExtensionCapableSQLiteCore(logger);
}

/**
 * On macOS without Homebrew sqlite3, bun:sqlite cannot load the sqlite-vec
 * extension, so any query against an existing `_vec` virtual table will fail
 * with "no such module: vec0". Detect that trap at DB-open time and throw a
 * helpful, actionable error instead of letting the user hit the cryptic one
 * deeper in the indexer.
 *
 * Safe to call after `new Database(...)` -- it only does a sqlite_master
 * lookup and never touches the vec0 module itself.
 */
export function assertVecExtensionAvailable(db: Database, tableName: string): void {
    if (!state().customSqliteAttempted) {
        ensureExtensionCapableSQLite();
    }

    if (state().homebrewDylibFound) {
        return;
    }

    const vecTable = `${tableName}_vec`;
    const exists = !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(vecTable);

    if (!exists) {
        return;
    }

    throw new Error(
        `sqlite-vec is required to read this index ("${tableName}" has a "${vecTable}" virtual table) ` +
            "but Bun's bundled SQLite on macOS does not support extension loading.\n\n" +
            "Fix one of:\n" +
            "  1. brew install sqlite   (then re-run the command)\n" +
            "  2. Rebuild the index with --vector-driver sqlite-brute (drops sqlite-vec)\n\n" +
            `Looked for libsqlite3.dylib at:\n  ${HOMEBREW_SQLITE_PATHS.map((p) => `- ${p}`).join("\n  ")}`
    );
}

/**
 * Attempt to load sqlite-vec extension on the given Database.
 * Returns true if successful, false if the extension is unavailable.
 * Caches the availability result -- if it failed once, it won't retry on
 * subsequent calls, but it WILL call sqliteVec.load() on each new Database
 * instance since extensions must be loaded per-connection.
 */
export function loadSqliteVec(db: Database): boolean {
    const s = state();

    if (s.extensionAvailable === false) {
        return false;
    }

    if (!s.customSqliteAttempted) {
        ensureExtensionCapableSQLite();
    }

    try {
        const sqliteVec = require("sqlite-vec");
        sqliteVec.load(db);
        s.extensionAvailable = true;
        return true;
    } catch (err) {
        s.extensionAvailable = false;
        logger.warn(
            `[sqlite-vec] loadSqliteVec failed - extension unavailable: ${
                err instanceof Error ? err.message : String(err)
            }`
        );
        return false;
    }
}

/**
 * Check whether sqlite-vec is available without loading it.
 */
export function isSqliteVecAvailable(): boolean {
    const s = state();

    if (s.extensionAvailable !== null) {
        return s.extensionAvailable;
    }

    try {
        require.resolve("sqlite-vec");
        s.extensionAvailable = true;
        return true;
    } catch {
        s.extensionAvailable = false;
        return false;
    }
}

/**
 * Reset all cached state (for testing only) -- clears the process-global
 * entry so a subsequent `ensureExtensionCapableSQLite()` re-attempts the
 * one-shot swap and availability is re-probed.
 */
export function resetSqliteVecState(): void {
    resetSqliteVecLoaderState();
}
