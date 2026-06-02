/**
 * The single DB access point — and the SQLite→Postgres swap point (Postgres-ready, D per task).
 *
 * Today the stub uses better-sqlite3 (zero external service). To go multi-tenant in prod, set
 * DD_CLOUD_DATABASE_DRIVER=postgres and DD_CLOUD_DATABASE_URL=<pg connection string>; the Postgres
 * branch below wires drizzle's node-postgres dialect against `schema.pg.ts` (a mirror of the SQLite
 * schema). Everything else in the app imports `db` from here and never touches a driver directly, so
 * the swap is contained to this file.
 *
 * NOTE: this module is SERVER-ONLY. It is imported only by server route handlers / server functions.
 */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { getCloudEnv } from "@/lib/server/env";
import { schema } from "./schema";

const env = getCloudEnv();

function resolveSqlitePath(url: string): string {
    if (url === ":memory:") {
        return url;
    }

    return isAbsolute(url) ? url : resolve(process.cwd(), url);
}

function createSqliteDb() {
    const path = resolveSqlitePath(env.databaseUrl);

    if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true });
    }

    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    return { sqlite, db: drizzleSqlite(sqlite, { schema }) };
}

function createDb() {
    if (env.databaseDriver === "postgres") {
        // Postgres-ready seam. drizzle-orm/node-postgres is installed; the `pg` driver and a
        // `schema.pg.ts` mirror are the only additions needed to go live. We fail loud rather than
        // silently fall back to SQLite so a misconfigured prod deploy is obvious.
        throw new Error(
            "DD_CLOUD_DATABASE_DRIVER=postgres is the documented prod path but not wired in this stub. " +
                "Add `pg` + a `schema.pg.ts` mirror and swap the dialect here (drizzle-orm/node-postgres). " +
                "See DevDashboard/research/22-impl-10-cloud-notes.md."
        );
    }

    return createSqliteDb();
}

const { sqlite, db } = createDb();

export { db, sqlite };
export type Db = typeof db;
