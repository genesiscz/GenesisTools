import type { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Migration } from "@genesiscz/utils/database/migrations";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("hub:nav");

/** The navigation log's tables in the hub's data.db (`openHubDb`). */
export const NAV_MIGRATIONS: Migration[] = [
    {
        id: "001-hub-nav-entries",
        description:
            "one row per place the hub showed: when, who (user, agent, link), the place, its title and the note",
        apply: (db) => {
            db.exec(`CREATE TABLE IF NOT EXISTS nav_entries (
                id TEXT PRIMARY KEY,
                at INTEGER NOT NULL,
                actor TEXT NOT NULL,
                title TEXT NOT NULL,
                target TEXT NOT NULL,
                note TEXT,
                from_session TEXT
            );`);
            db.exec("CREATE INDEX IF NOT EXISTS idx_nav_entries_at ON nav_entries(at);");
            db.exec("CREATE TABLE IF NOT EXISTS nav_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
        },
    },
];

/**
 * The log's first home was hub/navigation.db (2026-10-25): copied into data.db once, then renamed aside. Outside the
 * migrations because SQLite refuses ATTACH inside their transaction; INSERT OR IGNORE makes a second process harmless.
 */
export function importLegacyNavDb(db: Database): void {
    if (!db.filename || db.filename === ":memory:") {
        return;
    }

    const legacy = join(dirname(db.filename), "navigation.db");
    if (legacy === db.filename || !existsSync(legacy)) {
        return;
    }

    try {
        db.exec(`ATTACH DATABASE '${legacy.replaceAll("'", "''")}' AS legacy`);
        try {
            db.exec("INSERT OR IGNORE INTO nav_entries SELECT * FROM legacy.nav_entries");
            db.exec("INSERT OR IGNORE INTO nav_meta SELECT * FROM legacy.nav_meta");
        } finally {
            db.exec("DETACH DATABASE legacy");
        }

        const aside = `${legacy}.migrated-${new Date().toISOString().slice(0, 10)}`;
        renameSync(legacy, aside);
        log.info({ from: legacy, aside }, "hub nav: moved the log into data.db");
    } catch (error) {
        log.warn({ error, legacy }, "hub nav: could not move the old log into data.db; it stays where it is");
    }
}
