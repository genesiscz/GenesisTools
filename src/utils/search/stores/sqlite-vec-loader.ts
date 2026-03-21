import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

let extensionAvailable: boolean | null = null;
let customSqliteAttempted = false;

/** Known paths for Homebrew sqlite3 with extension support (arm64 first) */
const HOMEBREW_SQLITE_PATHS = [
    "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
];

/**
 * Try to swap bun:sqlite to a build that supports extension loading.
 * On macOS, the default bun-bundled sqlite3 does not support loadExtension().
 * This is a best-effort call -- the actual load() call will be the real test.
 */
function trySetCustomSQLite(): void {
    if (customSqliteAttempted) {
        return;
    }

    customSqliteAttempted = true;

    if (process.platform !== "darwin") {
        return;
    }

    for (const libPath of HOMEBREW_SQLITE_PATHS) {
        if (existsSync(libPath)) {
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

    trySetCustomSQLite();

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
