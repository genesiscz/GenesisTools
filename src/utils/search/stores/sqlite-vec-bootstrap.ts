import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

interface SqliteVecGlobalState {
    extensionAvailable: boolean | null;
    customSqliteAttempted: boolean;
    homebrewDylibFound: boolean;
}

interface SqliteVecLog {
    debug(message: string): void;
    warn(message: string): void;
}

const STATE_KEY = Symbol.for("genesis-tools.sqlite-vec.loader-state");

export const HOMEBREW_SQLITE_PATHS = [
    "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
];

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

export function getSqliteVecLoaderState(): SqliteVecGlobalState {
    return state();
}

export function resetSqliteVecLoaderState(): void {
    const g = globalThis as typeof globalThis & {
        [STATE_KEY]?: SqliteVecGlobalState;
    };

    delete g[STATE_KEY];
}

export function ensureExtensionCapableSQLiteCore(log?: SqliteVecLog): void {
    const s = state();

    if (s.customSqliteAttempted) {
        return;
    }

    s.customSqliteAttempted = true;

    if (process.platform !== "darwin") {
        s.homebrewDylibFound = true;
        return;
    }

    for (const libPath of HOMEBREW_SQLITE_PATHS) {
        if (existsSync(libPath)) {
            try {
                const swapped = Database.setCustomSQLite(libPath);

                if (swapped === false) {
                    log?.warn(
                        `[sqlite-vec] setCustomSQLite(${libPath}) returned false - a Database may have been ` +
                            "created before the preload ran; sqlite-vec will be unavailable."
                    );
                    return;
                }

                s.homebrewDylibFound = true;
                log?.debug(`[sqlite-vec] swapped in extension-capable SQLite: ${libPath}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);

                if (message.includes("SQLite already loaded")) {
                    log?.debug(
                        `[sqlite-vec] setCustomSQLite(${libPath}) skipped - SQLite already loaded ` +
                            "in this process (swap attempted by an earlier module instance / preload)."
                    );
                    return;
                }

                log?.warn(
                    `[sqlite-vec] setCustomSQLite(${libPath}) failed - sqlite-vec will be unavailable. ` +
                        `Cause: ${message}`
                );
            }

            return;
        }
    }
}
