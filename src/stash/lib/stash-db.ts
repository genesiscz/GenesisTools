import type { Database } from "bun:sqlite";
import { runMigrations } from "@app/utils/database/migrations";
import { STASH_MIGRATIONS } from "./stash-migrations";

export function openStashDb(db: Database): Database {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA journal_mode = WAL");
    runMigrations(db, STASH_MIGRATIONS, { tableName: "stash" });
    return db;
}
