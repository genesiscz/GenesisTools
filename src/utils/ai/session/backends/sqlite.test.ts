import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { SQL_NOW_UTC } from "@genesiscz/utils/sql-time";
import { createSessionStore } from "../store";
import { createSqliteSessionBackend } from "./sqlite";

/** youtube's ask tables, copied from src/youtube/lib/db.ts `add-ask-sessions`. */
function youtubeSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ask_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            collection_id INTEGER,
            scope_kind TEXT NOT NULL DEFAULT 'collection'
                CHECK (scope_kind IN ('collection','channel','videos','dir')),
            scope_value TEXT NOT NULL DEFAULT '',
            video_ids_json TEXT NOT NULL DEFAULT '[]',
            provider_spec TEXT,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC}),
            updated_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
        );
        CREATE TABLE IF NOT EXISTS ask_session_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
            content TEXT NOT NULL,
            tool_name TEXT,
            tool_args_json TEXT,
            citations_json TEXT,
            created_at TEXT NOT NULL DEFAULT (${SQL_NOW_UTC})
        );
    `);
}

function youtubeBackend(db: Database) {
    return createSqliteSessionBackend({
        db,
        sessionsTable: "ask_sessions",
        messagesTable: "ask_session_messages",
        manageSchema: false,
        timestamps: "iso",
        ownerType: "integer",
        columns: { session: { owner: "user_id" } },
        metaColumns: {
            session: [
                { column: "collection_id", key: "collectionId", encoding: "integer" },
                { column: "scope_kind", key: "scopeKind" },
                { column: "scope_value", key: "scopeValue" },
                { column: "video_ids_json", key: "videoIds" },
                { column: "provider_spec", key: "providerSpec" },
            ],
            message: [
                { column: "tool_name", key: "toolName" },
                { column: "tool_args_json", key: "toolArgs" },
                { column: "citations_json", key: "citations" },
            ],
        },
    });
}

describe("generic sqlite backend", () => {
    test("creates its own tables and round-trips a session with meta", async () => {
        const db = new Database(":memory:");
        const backend = createSqliteSessionBackend({ db });

        const created = await backend.create({ owner: "u1", title: "chat", meta: { app: "ask", pinned: true } });
        expect(created.id).toBe("1");
        expect(created.meta).toEqual({ app: "ask", pinned: true });

        const found = await backend.byTitle("u1", "chat");
        expect(found?.id).toBe(created.id);
        expect(found?.meta).toEqual({ app: "ask", pinned: true });
        expect(await backend.byTitle("u2", "chat")).toBeUndefined();
        expect(await backend.byId("999")).toBeUndefined();

        const applied = db.query("SELECT id FROM _migrations").all() as Array<{ id: string }>;
        expect(applied.map((r) => r.id)).toEqual(["ai_sessions:create-session-tables"]);
    });

    test("messages keep insertion order and touch moves updatedAt forward", async () => {
        const db = new Database(":memory:");
        const backend = createSqliteSessionBackend({ db });
        const session = await backend.create({ owner: "u1", title: "chat" });

        await backend.append({ sessionId: session.id, role: "user", content: "q" });
        await backend.append({ sessionId: session.id, role: "tool", content: "{}", meta: { name: "search" } });
        await backend.append({ sessionId: session.id, role: "assistant", content: "a" });

        const messages = await backend.messages(session.id);
        expect(messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
        expect(messages[1].meta).toEqual({ name: "search" });
        expect(messages.every((m) => m.sessionId === session.id)).toBe(true);

        db.run("UPDATE ai_sessions SET updated_at = 0 WHERE id = ?", [Number(session.id)]);
        await backend.touch(session.id);
        const after = await backend.byId(session.id);
        expect(after?.updatedAt).toBeGreaterThan(0);
    });

    test("rejects a table name that is not a bare identifier", () => {
        const db = new Database(":memory:");
        expect(() => createSqliteSessionBackend({ db, sessionsTable: "a; DROP TABLE b" })).toThrow(
            "Invalid SQL identifier"
        );
    });
});

describe("adopting youtube's ask tables", () => {
    test("reads rows written before this library existed, citations included", async () => {
        const db = new Database(":memory:");
        youtubeSchema(db);
        db.run(
            `INSERT INTO ask_sessions (user_id, collection_id, scope_kind, scope_value, video_ids_json, provider_spec, title, created_at, updated_at)
             VALUES (7, NULL, 'channel', '@some', '["vid1","vid2"]', 'anthropic/opus', 'probe', '2026-07-01T10:00:00.000Z', '2026-07-01T10:05:00.000Z')`
        );
        db.run(
            `INSERT INTO ask_session_messages (session_id, role, content, citations_json, created_at)
             VALUES (1, 'assistant', 'old answer', '[{"videoId":"vid1","start":12}]', '2026-07-01T10:05:00.000Z')`
        );
        const backend = youtubeBackend(db);

        const session = await backend.byTitle("7", "probe");
        expect(session).toBeDefined();
        expect(session?.id).toBe("1");
        expect(session?.owner).toBe("7");
        expect(session?.createdAt).toBe(Date.parse("2026-07-01T10:00:00.000Z"));
        expect(session?.meta).toEqual({
            scopeKind: "channel",
            scopeValue: "@some",
            videoIds: ["vid1", "vid2"],
            providerSpec: "anthropic/opus",
        });

        const messages = await backend.messages("1");
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe("old answer");
        expect(messages[0].meta).toEqual({ citations: [{ videoId: "vid1", start: 12 }] });
    });

    test("writes land in the domain columns, not a meta blob", async () => {
        const db = new Database(":memory:");
        youtubeSchema(db);
        const backend = youtubeBackend(db);

        const session = await backend.create({
            owner: "7",
            title: "fresh",
            meta: { scopeKind: "videos", scopeValue: "", videoIds: ["a"], providerSpec: null },
        });
        await backend.append({
            sessionId: session.id,
            role: "assistant",
            content: "answer",
            meta: { citations: [{ videoId: "a" }] },
        });
        await backend.append({
            sessionId: session.id,
            role: "tool",
            content: "result",
            meta: { toolName: "search", toolArgs: { q: "x" } },
        });

        const sessionRow = db.query("SELECT * FROM ask_sessions WHERE id = ?").get(Number(session.id)) as Record<
            string,
            unknown
        >;
        expect(sessionRow.user_id).toBe(7);
        expect(sessionRow.scope_kind).toBe("videos");
        expect(sessionRow.video_ids_json).toBe('["a"]');

        const rows = db.query("SELECT * FROM ask_session_messages ORDER BY id").all() as Array<Record<string, unknown>>;
        expect(rows[0].citations_json).toBe('[{"videoId":"a"}]');
        expect(rows[1].tool_name).toBe("search");
        expect(SafeJSON.parse(String(rows[1].tool_args_json), { strict: true, unbox: true })).toEqual({ q: "x" });
        expect(Object.keys(rows[0])).not.toContain("meta_json");
    });

    test("a full turn through the store lands in youtube's tables", async () => {
        const db = new Database(":memory:");
        youtubeSchema(db);
        const store = createSessionStore(youtubeBackend(db));

        const session = await store.getOrCreate("7", "probe", { scopeKind: "channel", scopeValue: "@c" });
        await store.turn(session.id, "q1", async () => ({ text: "a1", meta: { citations: [{ videoId: "v" }] } }));
        await store.turn(session.id, "q2", async (history) => `saw ${history.length}`);

        const history = await store.history(session.id);
        expect(history.map((m) => m.content)).toEqual(["q1", "a1", "q2", "saw 3"]);
        expect(history[1].meta).toEqual({ citations: [{ videoId: "v" }] });

        const same = await store.getOrCreate("7", "probe");
        expect(same.id).toBe(session.id);
        expect(same.meta).toMatchObject({ scopeKind: "channel", scopeValue: "@c" });
    });
});
