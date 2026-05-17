import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const isProd = process.env.NODE_ENV === "production";

const rawPath = process.env.SQLITE_PATH ?? ".data/dashboard.sqlite";
if (isProd && !isAbsolute(rawPath)) {
    throw new Error(
        `SQLITE_PATH must be an absolute path in production (got "${rawPath}"). ` +
            "A relative path resolves against the PM2 cwd and silently opens a different/empty DB."
    );
}

const DB_PATH = resolve(rawPath);
console.log(`[db] opening sqlite at ${DB_PATH}`);

const sqlite = new Database(DB_PATH);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
// Wait instead of throwing SQLITE_BUSY when a concurrent writer holds the lock
// (SSE + multiple tabs + better-sqlite3 single-writer).
sqlite.pragma("busy_timeout = 5000");
// Safe with WAL; far fewer fsyncs than the FULL default.
sqlite.pragma("synchronous = NORMAL");

export const db = drizzle(sqlite, { schema });

// Apply migrations at module init — every server function imports `db` from
// here, so this guarantees the schema is current before the first query.
// Absolute MIGRATIONS_DIR is required in prod (same cwd hazard as SQLITE_PATH);
// dev resolves the source folder relative to this file.
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("./migrations", import.meta.url));
try {
    console.log(`[db] applying migrations from ${MIGRATIONS_DIR}`);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log("[db] migrations up to date");
} catch (err) {
    console.error("[db] migration failed — refusing to serve with an unmigrated schema:", err);
    throw err;
}

const closeOnce = (() => {
    let closed = false;
    return () => {
        if (closed) {
            return;
        }

        closed = true;
        try {
            sqlite.close();
            console.log("[db] sqlite handle closed on shutdown");
        } catch (err) {
            console.error("[db] error closing sqlite on shutdown:", err);
        }

        process.exit(0);
    };
})();

// SIGTERM = PM2 reload: give in-flight requests / SSE ~3s to drain before
// closing the sqlite handle (well inside PM2 kill_timeout 8000ms).
// SIGINT = Ctrl-C in dev: close immediately.
process.once("SIGTERM", () => setTimeout(closeOnce, 3000));
process.once("SIGINT", closeOnce);

export { sqlite };

export * from "./schema";
