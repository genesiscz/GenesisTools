import type { Database } from "bun:sqlite";
import { SafeJSON } from "@genesiscz/utils/json";
import { isNavActor, NAV_DEFAULT_KEEP, type NavEntry, normalizeTarget } from "./types";

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

/** Persists a changed History setting and prunes immediately, even without a new visit. */
export function setNavKeep(db: Database, keep: number): { kept: number; dropped: number } {
    return db.transaction(() => {
        db.run("INSERT OR REPLACE INTO nav_meta (key, value) VALUES ('keep', ?)", [String(keep)]);
        return pruneNav(db, keep);
    })();
}

function pruneNav(db: Database, keep: number): { kept: number; dropped: number } {
    const dropped = db.run(
        "DELETE FROM nav_entries WHERE id NOT IN (SELECT id FROM nav_entries ORDER BY at DESC, rowid DESC LIMIT ?)",
        [keep]
    ).changes;
    return { kept: keep, dropped };
}

/**
 * Adds the entry, or replaces the row with its id, then keeps the newest `keep` rows. A `keep` given here is stored
 * as the cap for later writers that do not know it (an agent's `tools hub nav open`).
 */
export function recordNav(
    db: Database,
    entry: NavEntry,
    options: { keep?: number; replacing?: string[] } = {}
): { kept: number; dropped: number } {
    const { keep, replacing } = options;
    const write = db.transaction(() => {
        if (keep !== undefined) {
            db.run("INSERT OR REPLACE INTO nav_meta (key, value) VALUES ('keep', ?)", [String(keep)]);
        }

        for (const id of replacing ?? []) {
            if (id !== entry.id) {
                db.run("DELETE FROM nav_entries WHERE id = ?", [id]);
            }
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
        return pruneNav(db, keep ?? navKeep(db));
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
