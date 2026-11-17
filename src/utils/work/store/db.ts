import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { applyPragmas } from "@genesiscz/utils/database/pragmas";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { WORK_MIGRATIONS, WORK_SCHEMA_SCOPE } from "./schema";

/** `~/.genesis-tools/work/work.db`. */
export function workDbPath(): string {
    return genesisToolsDir("work", "work.db");
}

/** `~/.genesis-tools/work/journal/`, the mirror of the journal as one JSONL file per day. */
export function workJournalDir(): string {
    return genesisToolsDir("work", "journal");
}

/** Opens the store and brings its schema up to date. `:memory:` gives a store for a test. */
export function openWorkDb(path: string = workDbPath()): Database {
    if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true });
    }

    const db = new Database(path, { create: true });
    applyPragmas(db, { foreignKeys: false });
    runMigrations(db, WORK_MIGRATIONS, { tableName: WORK_SCHEMA_SCOPE });
    return db;
}

export function withWorkDb<T>(path: string | undefined, fn: (db: Database) => T): T {
    const db = openWorkDb(path);

    try {
        return fn(db);
    } finally {
        db.close();
    }
}
