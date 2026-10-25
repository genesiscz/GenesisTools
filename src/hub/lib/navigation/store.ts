import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage";
import { isNavActor, NAV_DEFAULT_KEEP, type NavEntry, normalizeTarget } from "./types";

const { log } = logger.scoped("hub:nav");

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

/** `~/.genesis-tools/hub/navigation.db`: one log per machine, shared by every hub and agent. */
export function navDbPath(): string {
    return join(new Storage("hub").getBaseDir(), "navigation.db");
}

export function openNavDb(dbPath: string = navDbPath()): Database {
    if (dbPath !== ":memory:") {
        mkdirSync(dirname(dbPath), { recursive: true });
    }

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 2000;");
    runMigrations(db, NAV_MIGRATIONS, { tableName: "hub_nav" });
    log.debug({ dbPath }, "hub nav: opened the log");
    return db;
}

interface NavRow {
    id: string;
    at: number;
    actor: string;
    title: string;
    target: string;
    note: string | null;
    from_session: string | null;
}

function fromRow(row: NavRow): NavEntry {
    const entry: NavEntry = {
        id: row.id,
        at: row.at,
        actor: isNavActor(row.actor) ? row.actor : "user",
        title: row.title,
        target: normalizeTarget(SafeJSON.parse(row.target, { strict: true })),
    };

    if (row.note) {
        entry.note = row.note;
    }

    if (row.from_session) {
        entry.from = row.from_session;
    }

    return entry;
}

/** The cap the hub last set (its History setting), else the default. */
export function navKeep(db: Database): number {
    const row = db.query<{ value: string }, []>("SELECT value FROM nav_meta WHERE key = 'keep'").get();
    const keep = row ? Number(row.value) : Number.NaN;
    return Number.isInteger(keep) && keep > 0 ? keep : NAV_DEFAULT_KEEP;
}

/**
 * Adds the entry, or replaces the row with its id, then keeps the newest `keep` rows. A `keep` given here is stored
 * as the cap for later writers that do not know it (an agent's `tools hub nav open`).
 */
export function recordNav(db: Database, entry: NavEntry, keep?: number): { kept: number; dropped: number } {
    const write = db.transaction(() => {
        if (keep !== undefined) {
            db.run("INSERT OR REPLACE INTO nav_meta (key, value) VALUES ('keep', ?)", [String(keep)]);
        }

        db.run(
            `INSERT OR REPLACE INTO nav_entries (id, at, actor, title, target, note, from_session)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                entry.id,
                entry.at,
                entry.actor,
                entry.title,
                SafeJSON.stringify(normalizeTarget(entry.target)),
                entry.note ?? null,
                entry.from ?? null,
            ]
        );
        const cap = keep ?? navKeep(db);
        const dropped = db.run(
            "DELETE FROM nav_entries WHERE id NOT IN (SELECT id FROM nav_entries ORDER BY at DESC, rowid DESC LIMIT ?)",
            [cap]
        ).changes;
        return { kept: cap, dropped };
    });
    return write();
}

/** Newest first. */
export function listNav(db: Database, limit?: number): NavEntry[] {
    const rows =
        limit === undefined
            ? db.query<NavRow, []>("SELECT * FROM nav_entries ORDER BY at DESC, rowid DESC").all()
            : db.query<NavRow, [number]>("SELECT * FROM nav_entries ORDER BY at DESC, rowid DESC LIMIT ?").all(limit);
    return rows.map(fromRow);
}
