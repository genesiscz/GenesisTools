/**
 * Applies drizzle migrations on first DB access (idempotent — drizzle tracks applied IDs in its
 * own __drizzle_migrations table). SERVER-ONLY. Called once at server boot via `ensureMigrated()`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getCloudEnv } from "@/lib/server/env";
import { db } from "./index";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

let migrated = false;

export function ensureMigrated(): void {
    if (migrated) {
        return;
    }

    const env = getCloudEnv();

    if (env.databaseDriver !== "sqlite") {
        // Postgres prod path runs migrations out-of-band (CI / deploy step), not on boot.
        migrated = true;
        return;
    }

    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    migrated = true;
}
