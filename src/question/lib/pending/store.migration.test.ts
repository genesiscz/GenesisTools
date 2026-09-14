import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { openReadModel } from "../read-model";
import { openPendingStore, PENDING_MIGRATIONS } from "./store";

/**
 * The pending table is added to `~/.genesis-tools/question/qa.db`, which ALREADY holds real
 * Q→A history (the `entries` read model) and, in the same file, the handoff read model.
 *
 * Every test elsewhere starts from an empty `:memory:` database, so none of them can catch a
 * migration that drops, rewrites or reorders rows that were already there. These start from a
 * POPULATED file instead and assert the pre-existing data survives byte for byte.
 */

let dir = "";
let dbPath = "";

const ENTRY_COLUMNS =
    "id,ts,session_id,session_title,project,repo_root,cwd,branch,commit_sha,commit_message,agent," +
    "is_worktree,worktree_path,ai_agent,agent_label,tag,question,answer_md,refs_json,source," +
    "turn_uuid,superseded_by,read_at,dedupe_key";

interface EntryRow {
    id: string;
    ts: number;
    question: string;
    answer_md: string;
    project: string;
    read_at: number | null;
}

/** A qa.db as it looks on a machine that has been recording answers for months. */
function seedHistory(path: string): EntryRow[] {
    const db = openReadModel(path);
    const insert = db.prepare(
        `INSERT INTO entries (${ENTRY_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    for (let i = 1; i <= 25; i++) {
        insert.run(
            `entry-${i}`,
            1_700_000_000_000 + i * 1000,
            `sess-${i}`,
            `Session ${i}`,
            "GenesisTools",
            "/repo",
            "/repo",
            "master",
            "abc123",
            "a commit",
            "claude-code",
            0,
            null,
            "claude",
            "Claude",
            "question",
            `question number ${i}`,
            `answer number ${i}`,
            null,
            "mcp",
            null,
            null,
            i % 3 === 0 ? 1_700_000_500_000 : null,
            `dedupe-${i}`
        );
    }

    // A second co-resident table, so the test also covers a neighbour the migration never names.
    db.exec("CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, title TEXT NOT NULL, tasks TEXT NOT NULL);");
    db.prepare("INSERT INTO handoffs (id, title, tasks) VALUES (?, ?, ?)").run("h1", "a handoff", "[]");

    const rows = db
        .query(`SELECT id, ts, question, answer_md, project, read_at FROM entries ORDER BY rowid`)
        .all() as EntryRow[];
    db.close();

    return rows;
}

function readHistory(path: string): EntryRow[] {
    const db = new Database(path, { readonly: true });
    const rows = db
        .query("SELECT id, ts, question, answer_md, project, read_at FROM entries ORDER BY rowid")
        .all() as EntryRow[];
    db.close();

    return rows;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gt-qa-migration-"));
    dbPath = join(dir, "qa.db");
});

afterEach(() => {
    // The scratch dir is under /tmp and goes with the next reboot; nothing here is deleted.
});

describe("the qa_pending migration against a populated qa.db", () => {
    test("every pre-existing history row survives the migration unchanged", () => {
        const before = seedHistory(dbPath);

        expect(before).toHaveLength(25);

        const db = openPendingStore(dbPath);
        db.close();

        const after = readHistory(dbPath);

        expect(after).toHaveLength(before.length);
        expect(after).toEqual(before);
    });

    test("a co-resident table the migration never names is untouched", () => {
        seedHistory(dbPath);
        const db = openPendingStore(dbPath);
        db.close();

        const check = new Database(dbPath, { readonly: true });
        const handoffs = check.query("SELECT id, title FROM handoffs").all() as { id: string; title: string }[];
        check.close();

        expect(handoffs).toEqual([{ id: "h1", title: "a handoff" }]);
    });

    test("opening the store repeatedly applies the migration once and never re-runs DDL", () => {
        const before = seedHistory(dbPath);

        for (let i = 0; i < 3; i++) {
            const db = openPendingStore(dbPath);
            db.close();
        }

        const check = new Database(dbPath, { readonly: true });
        const applied = check.query("SELECT id FROM _migrations WHERE id LIKE 'qa_pending:%' ORDER BY id").all() as {
            id: string;
        }[];
        check.close();

        expect(applied).toEqual([{ id: "qa_pending:001-qa-pending" }, { id: "qa_pending:002-qa-pending-claim" }]);
        expect(readHistory(dbPath)).toEqual(before);
    });

    test("the migration id is SCOPED, so it cannot collide with another subsystem's 001", () => {
        // `tableName` is the id scope, not the table being created. If it were read as a table
        // name the bookkeeping table would be called `qa_pending` and would collide with the
        // data table of that name, which is the failure this pins.
        seedHistory(dbPath);
        const db = openPendingStore(dbPath);
        const columns = db.query("PRAGMA table_info(qa_pending)").all() as { name: string }[];
        const bookkeeping = db.query("PRAGMA table_info(_migrations)").all() as { name: string }[];
        db.close();

        expect(columns.map((c) => c.name)).toContain("items_json");
        expect(columns.map((c) => c.name)).toContain("status");
        expect(bookkeeping.map((c) => c.name)).toEqual(["id", "applied_at", "ms"]);
    });

    test("the migrations only CREATE or ADD COLUMN: no DROP, DELETE, UPDATE or rewriting ALTER", () => {
        // Cheap structural guard. A future migration that rewrites history would have to add
        // one of these verbs, and this test is where that shows up. `ALTER TABLE … ADD COLUMN`
        // is the one permitted ALTER: it edits the schema only, leaves every existing row byte
        // for byte, and reads back as NULL — the test below proves that on real rows. Every
        // other ALTER (DROP COLUMN, RENAME) rewrites the table and stays banned.
        const ddl = PENDING_MIGRATIONS.map((m) => m.apply.toString())
            .join("\n")
            .toUpperCase();
        const alters = ddl.match(/ALTER\s+TABLE\s+\S+\s+[A-Z]+(\s+[A-Z]+)?/g) ?? [];

        expect(ddl).toContain("CREATE TABLE IF NOT EXISTS");
        expect(ddl).not.toContain("DROP ");
        expect(ddl).not.toContain("DELETE ");
        expect(ddl).not.toContain("UPDATE ");
        expect(alters).not.toHaveLength(0);

        for (const alter of alters) {
            expect(alter).toContain("ADD COLUMN");
        }
    });

    test("pending rows written before the claim column survive the migration that adds it", () => {
        // The claim lease is an ADD COLUMN on a table that already holds live forms on every
        // machine that ran this branch before it. They must come back identical, with no claim.
        // Applying 001 alone reproduces such a machine exactly, rather than approximating it.
        const seeded = new Database(dbPath);
        runMigrations(seeded, PENDING_MIGRATIONS.slice(0, 1), { tableName: "qa_pending" });
        seeded
            .prepare(
                `INSERT INTO qa_pending
                 (id, created_at, status, source, session_hint, project_path, cwd, items_json, timeout_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run("ask_old", 1_700_000_000_000, "pending", "cli", "sess-1", "/repo", "/repo", "[]", 60_000);
        seeded.close();

        const migrated = openPendingStore(dbPath);
        const row = migrated.query("SELECT * FROM qa_pending WHERE id = 'ask_old'").get() as Record<string, unknown>;
        migrated.close();

        expect(row).toEqual({
            id: "ask_old",
            created_at: 1_700_000_000_000,
            resolved_at: null,
            status: "pending",
            source: "cli",
            session_hint: "sess-1",
            project_path: "/repo",
            cwd: "/repo",
            items_json: "[]",
            answers_json: null,
            timeout_ms: 60_000,
            entry_id: null,
            claimed_at: null,
        });
    });

    test("history written BEFORE the migration is still readable by the read model after it", () => {
        seedHistory(dbPath);
        const db = openPendingStore(dbPath);
        db.close();

        // Reopening through the normal read-model path must not need a repair or a rebuild.
        const reopened = openReadModel(dbPath);
        const count = reopened.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
        reopened.close();

        expect(count.n).toBe(25);
    });
});
