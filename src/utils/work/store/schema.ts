import type { Migration } from "@genesiscz/utils/database/migrations";

/** The scope of the work store's migrations in `_migrations`. */
export const WORK_SCHEMA_SCOPE = "work";

export const WORK_MIGRATIONS: Migration[] = [
    {
        id: "2026-11-work-v1",
        description: "items, references, pointers, claims, handoffs, pairings, the journal, requests, cursors",
        apply(db) {
            db.run(`CREATE TABLE items (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                state TEXT NOT NULL,
                project TEXT NOT NULL,
                rev INTEGER NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                acceptance TEXT,
                severity TEXT,
                for_who TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                fields TEXT NOT NULL DEFAULT '{}',
                worker TEXT,
                created_by TEXT NOT NULL,
                created_ts TEXT NOT NULL,
                updated_ts TEXT NOT NULL,
                closed_ts TEXT
            )`);
            db.run("CREATE INDEX items_project_state ON items(project, state)");
            db.run("CREATE INDEX items_type ON items(type)");

            db.run(`CREATE TABLE refs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                to_id TEXT NOT NULL,
                slot TEXT,
                by TEXT NOT NULL,
                ts TEXT NOT NULL
            )`);
            db.run("CREATE UNIQUE INDEX refs_one_parent ON refs(from_id) WHERE kind = 'parent'");
            db.run("CREATE UNIQUE INDEX refs_member_slot ON refs(from_id, slot) WHERE kind = 'member'");
            db.run("CREATE UNIQUE INDEX refs_pair ON refs(from_id, kind, to_id) WHERE kind <> 'member'");
            db.run("CREATE INDEX refs_to ON refs(to_id, kind)");

            db.run(`CREATE TABLE pointers (
                item TEXT NOT NULL,
                kind TEXT NOT NULL,
                target TEXT NOT NULL,
                meta TEXT,
                ts TEXT NOT NULL,
                PRIMARY KEY (item, kind, target)
            )`);

            db.run(`CREATE TABLE claims (
                item TEXT NOT NULL,
                session_id TEXT NOT NULL,
                by TEXT NOT NULL,
                ts TEXT NOT NULL,
                active INTEGER NOT NULL,
                PRIMARY KEY (item, session_id)
            )`);
            db.run("CREATE INDEX claims_session ON claims(session_id, active)");

            // The edit credential of a handoff is stored here and selected by no read.
            db.run(`CREATE TABLE handoffs (
                id TEXT PRIMARY KEY,
                name TEXT,
                target TEXT,
                edit_credential TEXT
            )`);

            db.run(`CREATE TABLE pairings (
                item TEXT NOT NULL,
                connector TEXT NOT NULL,
                remote_key TEXT NOT NULL,
                born TEXT NOT NULL,
                origin TEXT NOT NULL,
                state TEXT NOT NULL,
                updated_ts TEXT NOT NULL,
                PRIMARY KEY (item, connector)
            )`);

            db.run(`CREATE TABLE changes (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                v INTEGER NOT NULL,
                ts TEXT NOT NULL,
                item TEXT NOT NULL,
                actor TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                origin TEXT NOT NULL,
                request TEXT,
                stamp TEXT
            )`);
            db.run("CREATE INDEX changes_item ON changes(item, seq)");

            db.run(`CREATE TABLE requests (
                principal TEXT NOT NULL,
                request_id TEXT NOT NULL,
                reply TEXT NOT NULL,
                ts TEXT NOT NULL,
                PRIMARY KEY (principal, request_id)
            )`);

            db.run(`CREATE TABLE cursors (
                consumer TEXT PRIMARY KEY,
                seq INTEGER NOT NULL,
                lease_owner TEXT,
                lease_until TEXT
            )`);

            db.run(`CREATE TABLE legacy_cursor (
                uid TEXT PRIMARY KEY,
                handoff TEXT NOT NULL,
                ts TEXT NOT NULL
            )`);

            db.run("CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, title, body)");
        },
    },
    {
        id: "2026-11-work-v2-handoff-meta",
        description:
            "the work store's own handoff table becomes handoff_meta; the name handoffs is the legacy view's (P6)",
        apply(db) {
            db.run("ALTER TABLE handoffs RENAME TO handoff_meta");
        },
    },
];
