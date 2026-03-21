/**
 * Preload script for sqlite-vec tests.
 * Must be loaded BEFORE any Database instance is created.
 *
 * Usage: bun test --preload ./src/utils/search/stores/sqlite-vec-preload.ts
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const HOMEBREW_SQLITE_PATHS = [
    "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
];

if (process.platform === "darwin") {
    for (const libPath of HOMEBREW_SQLITE_PATHS) {
        if (existsSync(libPath)) {
            try {
                Database.setCustomSQLite(libPath);
            } catch {
                // Already loaded -- nothing we can do
            }

            break;
        }
    }
}
