import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCompactHistorySchema, initializeHistorySchema, PRE_COMPACT_BACKUP_SUFFIX } from "./migrations";

test("upgrades legacy metadata without replacing its recorded values", () => {
    const db = new Database(":memory:");

    try {
        db.exec(`
            CREATE TABLE session_metadata (
                file_path TEXT PRIMARY KEY, session_id TEXT, custom_title TEXT,
                summary TEXT, first_prompt TEXT, git_branch TEXT, project TEXT,
                cwd TEXT, mtime INTEGER NOT NULL, first_timestamp TEXT,
                is_subagent INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO session_metadata VALUES (
                '/invented/session.jsonl', 'native-one', 'Kept title', NULL,
                'Kept prompt', 'fixture-main', 'fixture', '/invented', 42,
                '2026-08-15T12:00:00Z', 0
            );
        `);
        initializeHistorySchema(db);
        initializeHistorySchema(db);

        expect(db.query("SELECT custom_title, first_prompt, all_user_text FROM session_metadata").get()).toEqual({
            custom_title: "Kept title",
            first_prompt: "Kept prompt",
            all_user_text: null,
        });
        expect(db.query("SELECT COUNT(*) AS count FROM session_metadata").get()).toEqual({ count: 1 });
    } finally {
        db.close();
    }
});

test("provider keys preserve legacy fields and permit several sessions at one physical path", () => {
    const db = new Database(":memory:");

    try {
        initializeHistorySchema(db);
        db.exec(`
            ALTER TABLE session_metadata ADD COLUMN local_note TEXT DEFAULT 'retained';
            CREATE INDEX fixture_metadata_note ON session_metadata(local_note);
            INSERT INTO session_metadata (file_path, session_id, custom_title, mtime)
            VALUES ('/invented/legacy.jsonl', 'old-id', 'Kept title', 42);
            CREATE TABLE usage_snapshots (id INTEGER PRIMARY KEY, observation TEXT);
            INSERT INTO usage_snapshots VALUES (1, 'Historical observation');
        `);
        initializeCompactHistorySchema(db);
        initializeCompactHistorySchema(db);

        expect(db.query("SELECT provider, source_key, custom_title, local_note FROM session_metadata").get()).toEqual({
            provider: "anthropic-sub",
            source_key: '["legacy","anthropic-sub","","/invented/legacy.jsonl"]',
            custom_title: "Kept title",
            local_note: "retained",
        });
        db.exec(`
            INSERT INTO session_metadata (source_key, provider, file_path, mtime)
            VALUES ('fixture-one', 'fixture-sub', '/invented/shared.jsonl', 1),
                   ('fixture-two', 'fixture-sub', '/invented/shared.jsonl', 1);
        `);
        expect(db.query("SELECT COUNT(*) AS count FROM session_metadata WHERE provider='fixture-sub'").get()).toEqual({
            count: 2,
        });
        expect(db.query("SELECT observation FROM usage_snapshots").get()).toEqual({
            observation: "Historical observation",
        });
        expect(db.query("SELECT name FROM sqlite_master WHERE name = 'fixture_metadata_note'").get()).toEqual({
            name: "fixture_metadata_note",
        });
    } finally {
        db.close();
    }
});

test("source freshness gets a logical key without claiming old statistics are newly refreshed", () => {
    const db = new Database(":memory:");

    try {
        initializeHistorySchema(db);
        db.exec(`
            INSERT INTO file_index (file_path, mtime, message_count, first_date, last_date, project, is_subagent, last_indexed)
            VALUES ('/invented/legacy.jsonl', 42, 7, '2026-08-15', '2026-08-16', 'fixture', 0, 'old-observation');
        `);
        initializeCompactHistorySchema(db);

        expect(
            db
                .query(`SELECT source_key, provider, mtime, message_count, first_date, last_date,
            last_indexed, metadata_revision, stats_revision, statistics_status FROM file_index`)
                .get()
        ).toEqual({
            source_key: '["legacy","anthropic-sub","","/invented/legacy.jsonl"]',
            provider: "anthropic-sub",
            mtime: 42,
            message_count: 7,
            first_date: "2026-08-15",
            last_date: "2026-08-16",
            last_indexed: "old-observation",
            metadata_revision: null,
            stats_revision: null,
            statistics_status: "legacy",
        });
    } finally {
        db.close();
    }
});

test("daily statistics and quick totals keep independent provider scopes", () => {
    const db = new Database(":memory:");

    try {
        initializeHistorySchema(db);
        db.exec(`
            INSERT INTO daily_stats (date, project, conversations, messages, computed_at)
            VALUES ('2026-08-15', '__all__', 1, 3, 'kept');
            INSERT INTO totals_cache (id, total_conversations, total_messages, last_updated)
            VALUES (1, 1, 3, 'kept');
        `);
        initializeCompactHistorySchema(db);
        db.exec(`
            INSERT INTO daily_stats (provider, date, project, conversations, messages, computed_at)
            VALUES ('openai-sub', '2026-08-15', '__all__', 2, 5, 'new');
            INSERT INTO totals_cache (provider, total_conversations, total_messages, last_updated)
            VALUES ('openai-sub', 2, 5, 'new');
        `);

        expect(db.query("SELECT provider, messages FROM daily_stats ORDER BY provider").all()).toEqual([
            { provider: "anthropic-sub", messages: 3 },
            { provider: "openai-sub", messages: 5 },
        ]);
        expect(
            db.query("SELECT provider, id, scope, total_messages FROM totals_cache ORDER BY provider").all()
        ).toEqual([
            { provider: "anthropic-sub", id: 1, scope: "__all__", total_messages: 3 },
            { provider: "openai-sub", id: 1, scope: "__all__", total_messages: 5 },
        ]);
    } finally {
        db.close();
    }
});

test("the one-way provider rewrite copies the database aside exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "gt-history-backup-"));
    const path = join(root, "index.db");
    const backup = `${path}${PRE_COMPACT_BACKUP_SUFFIX}`;

    try {
        const first = new Database(path);
        initializeHistorySchema(first);
        first.exec("INSERT INTO cache_meta (key, value) VALUES ('fixture', 'before')");
        first.close();

        const second = new Database(path);
        initializeCompactHistorySchema(second);
        second.exec("UPDATE cache_meta SET value = 'after' WHERE key = 'fixture'");
        second.close();

        expect(existsSync(backup)).toBe(true);
        const restored = new Database(backup, { readonly: true });
        // The copy predates the rewrite: it still keys metadata by file_path, so the previous
        // release can write to it.
        expect(
            restored.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='session_metadata'").get()
                ?.sql
        ).toContain("file_path TEXT PRIMARY KEY");
        expect(
            restored.query<{ value: string }, []>("SELECT value FROM cache_meta WHERE key='fixture'").get()?.value
        ).toBe("before");
        restored.close();

        const third = new Database(path);
        initializeCompactHistorySchema(third);
        third.close();
        const untouched = new Database(backup, { readonly: true });
        expect(
            untouched.query<{ value: string }, []>("SELECT value FROM cache_meta WHERE key='fixture'").get()?.value
        ).toBe("before");
        untouched.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
