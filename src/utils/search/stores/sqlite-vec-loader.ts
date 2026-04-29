import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

let extensionAvailable: boolean | null = null;
let customSqliteAttempted = false;
let homebrewDylibFound = false;

/** Known paths for Homebrew sqlite3 with extension support (arm64 first) */
const HOMEBREW_SQLITE_PATHS = [
    "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
];

/**
 * Try to swap bun:sqlite to a build that supports extension loading.
 * On macOS, the default bun-bundled sqlite3 does not support loadExtension().
 * This is a best-effort call -- the actual load() call will be the real test.
 *
 * MUST be called BEFORE any Database instance is created. Call this early in
 * your program entry point if you plan to use sqlite-vec.
 */
export function ensureExtensionCapableSQLite(): void {
    if (customSqliteAttempted) {
        return;
    }

    customSqliteAttempted = true;

    if (process.platform !== "darwin") {
        // Linux and Windows ship Bun with extension-capable SQLite already.
        homebrewDylibFound = true;
        return;
    }

    for (const libPath of HOMEBREW_SQLITE_PATHS) {
        if (existsSync(libPath)) {
            homebrewDylibFound = true;

            try {
                Database.setCustomSQLite(libPath);
            } catch {
                // Already set by preload or another module -- that's fine
            }

            return;
        }
    }
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
    if (!customSqliteAttempted) {
        ensureExtensionCapableSQLite();
    }

    if (homebrewDylibFound) {
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
    if (extensionAvailable === false) {
        return false;
    }

    // ensureExtensionCapableSQLite() should already have been called before
    // any Database was created. Call it here as a safety net, but it may be
    // too late if a Database instance already exists.
    if (!customSqliteAttempted) {
        ensureExtensionCapableSQLite();
    }

    try {
        const sqliteVec = require("sqlite-vec");
        sqliteVec.load(db);
        extensionAvailable = true;
        return true;
    } catch {
        extensionAvailable = false;
        return false;
    }
}

/**
 * Check whether sqlite-vec is available without loading it.
 */
export function isSqliteVecAvailable(): boolean {
    if (extensionAvailable !== null) {
        return extensionAvailable;
    }

    try {
        require.resolve("sqlite-vec");
        extensionAvailable = true;
        return true;
    } catch {
        extensionAvailable = false;
        return false;
    }
}

/**
 * Reset the cached availability state (for testing only).
 */
export function resetSqliteVecState(): void {
    extensionAvailable = null;
}
