import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { importLegacyNavDb, NAV_MIGRATIONS } from "./navigation/schema";

const { log } = logger.scoped("hub:data");

/**
 * Every hub feature that keeps rows: one scope each, all in one file. A new feature adds its migrations here instead
 * of opening another SQLite file (Martin, 2026-10-25: "no need to create sqlite db for every thing").
 */
const HUB_SCHEMAS: ReadonlyArray<{ scope: string; migrations: Migration[] }> = [
    { scope: "hub_nav", migrations: NAV_MIGRATIONS },
];

/** `~/.genesis-tools/hub/data.db`: the hub's own data, one file per machine, shared by every hub and agent. */
export function hubDbPath(): string {
    return join(new Storage("hub").getBaseDir(), "data.db");
}

/** Opens data.db (or `:memory:` in a test) with every hub schema applied. */
export function openHubDb(dbPath: string = hubDbPath()): Database {
    if (dbPath !== ":memory:") {
        mkdirSync(dirname(dbPath), { recursive: true });
    }

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 2000;");
    for (const { scope, migrations } of HUB_SCHEMAS) {
        runMigrations(db, migrations, { tableName: scope });
    }

    importLegacyNavDb(db);
    log.debug({ dbPath }, "hub data: opened");
    return db;
}
