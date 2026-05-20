import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { logger } from "@app/logger";

/**
 * `Database.setCustomSQLite()` is a *process-global, one-shot* native call.
 * The guard that tracks "have we already attempted it?" must therefore live
 * at process scope too, NOT module scope.
 *
 * This module is loaded TWICE in a normal `tools` invocation: once via the
 * launcher's `--preload <absolute path>` and once via bunfig.toml's relative
 * `./src/...` preload entry. Bun keys its module cache by specifier, so the
 * absolute and relative paths resolve to two distinct module instances. A
 * module-level `let` guard is `false` in each, so the second instance called
 * `setCustomSQLite()` again — the native side throws "SQLite already loaded"
 * and we logged a spurious WARN (15-27/day) even though the first call had
 * already swapped successfully and sqlite-vec was working fine. Hanging the
 * state off `globalThis` makes both instances share one guard.
 */
interface SqliteVecGlobalState {
    extensionAvailable: boolean | null;
    customSqliteAttempted: boolean;
    homebrewDylibFound: boolean;
}

const STATE_KEY = Symbol.for("genesis-tools.sqlite-vec.loader-state");

function state(): SqliteVecGlobalState {
    const g = globalThis as typeof globalThis & {
        [STATE_KEY]?: SqliteVecGlobalState;
    };

    if (!g[STATE_KEY]) {
        g[STATE_KEY] = {
            extensionAvailable: null,
            customSqliteAttempted: false,
            homebrewDylibFound: false,
        };
    }

    return g[STATE_KEY];
}

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
    const s = state();

    if (s.customSqliteAttempted) {
        return;
    }

    s.customSqliteAttempted = true;

    if (process.platform !== "darwin") {
        // Linux and Windows ship Bun with extension-capable SQLite already.
        s.homebrewDylibFound = true;
        return;
    }

    for (const libPath of HOMEBREW_SQLITE_PATHS) {
        if (existsSync(libPath)) {
            try {
                const swapped = Database.setCustomSQLite(libPath);
                if (swapped === false) {
                    logger.warn(
                        `[sqlite-vec] setCustomSQLite(${libPath}) returned false - a Database may have been ` +
                            "created before the preload ran; sqlite-vec will be unavailable."
                    );
                    return;
                }

                s.homebrewDylibFound = true;
                logger.debug(`[sqlite-vec] swapped in extension-capable SQLite: ${libPath}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                // "SQLite already loaded" is the benign double-attempt: another
                // module instance / duplicate preload already ran the one-shot
                // swap in THIS process (the global guard makes that a no-op, but
                // a path that bypasses it still lands here). If the earlier
                // attempt succeeded, sqlite-vec works fine; if a Database loaded
                // SQLite before any swap, loadSqliteVec() reports the real,
                // actionable failure with its own warn. Either way THIS throw
                // is not actionable — debug, not warn, so it stops being noise.
                if (message.includes("SQLite already loaded")) {
                    logger.debug(
                        `[sqlite-vec] setCustomSQLite(${libPath}) skipped - SQLite already loaded ` +
                            "in this process (swap attempted by an earlier module instance / preload)."
                    );

                    return;
                }

                logger.warn(
                    `[sqlite-vec] setCustomSQLite(${libPath}) failed - sqlite-vec will be unavailable. ` +
                        `Cause: ${message}`
                );
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

    // ensureExtensionCapableSQLite() should already have been called before
    // any Database was created. Call it here as a safety net, but it may be
    // too late if a Database instance already exists.
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
    const g = globalThis as typeof globalThis & {
        [STATE_KEY]?: SqliteVecGlobalState;
    };

    delete g[STATE_KEY];
}
