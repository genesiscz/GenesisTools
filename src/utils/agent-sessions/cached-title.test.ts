import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    listRecentCachedSessions,
    readCachedHistoryTitle,
    readCachedSessionCwd,
    resolveCachedSessionId,
} from "./cached-title";
import { initializeCompactHistorySchema, initializeHistorySchema } from "./migrations";
import { createFixtureWorld } from "./testing/fixture-world";

test("cached title lookup neither creates missing storage nor migrates a legacy schema", async () => {
    const world = await createFixtureWorld();
    const missing = join(world.root, "absent", "index.db");

    try {
        expect(
            readCachedHistoryTitle({ path: missing, providerId: "anthropic-sub", sessionId: "fixture-session" })
        ).toBeNull();
        expect(existsSync(join(world.root, "absent"))).toBe(false);
        const db = new Database(world.databases.legacy);
        initializeHistorySchema(db);
        db.query("INSERT INTO session_metadata(file_path,session_id,custom_title,mtime) VALUES (?,?,?,?)").run(
            "/fixture/session.jsonl",
            "fixture-session",
            "Kept title",
            1
        );
        const schema = db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
        expect(
            readCachedHistoryTitle({
                path: world.databases.legacy,
                providerId: "anthropic-sub",
                sessionId: "fixture-session",
            })
        ).toEqual({ customTitle: "Kept title", summary: null });
        expect(
            readCachedHistoryTitle({
                path: world.databases.legacy,
                providerId: "openai-sub",
                sessionId: "fixture-session",
            })
        ).toBeNull();
        expect(db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        db.close();
    } finally {
        await world.dispose();
    }
});

test("cached title lookup scopes provider and prefers the exact native identity over child parent IDs", async () => {
    const world = await createFixtureWorld();
    const db = new Database(world.databases.candidate);

    try {
        initializeCompactHistorySchema(db);
        const insert = db.prepare(
            "INSERT INTO session_metadata(source_key,provider,native_id,file_path,session_id,custom_title,mtime,is_subagent) VALUES (?,?,?,?,?,?,?,?)"
        );
        insert.run("main", "anthropic-sub", "shared-id", "/fixture/main.jsonl", "shared-id", "Parent title", 1, 0);
        insert.run(
            "child",
            "anthropic-sub",
            "agent-child",
            "/fixture/agent-child.jsonl",
            "shared-id",
            "Child title",
            3,
            1
        );
        insert.run("other", "openai-sub", "shared-id", "/fixture/rollout.jsonl", "shared-id", "Other provider", 4, 0);
        expect(
            readCachedHistoryTitle({
                path: world.databases.candidate,
                providerId: "anthropic-sub",
                sessionId: "shared-id",
            })?.customTitle
        ).toBe("Parent title");
        expect(
            readCachedHistoryTitle({
                path: world.databases.candidate,
                providerId: "anthropic-sub",
                sessionId: "agent-child",
            })?.customTitle
        ).toBe("Child title");
        expect(
            readCachedHistoryTitle({
                path: world.databases.candidate,
                providerId: "openai-sub",
                sessionId: "shared-id",
            })?.customTitle
        ).toBe("Other provider");
        expect(
            readCachedHistoryTitle({ path: world.databases.candidate, providerId: "grok-sub", sessionId: "shared-id" })
        ).toBeNull();
    } finally {
        db.close();
        await world.dispose();
    }
});

test("a session id prefix resolves through the index: exact, unique, ambiguous, or none", async () => {
    const world = await createFixtureWorld();
    const db = new Database(world.databases.candidate);

    try {
        initializeCompactHistorySchema(db);
        const insert = db.prepare(
            "INSERT INTO session_metadata(source_key,provider,native_id,file_path,session_id,custom_title,mtime,is_subagent) VALUES (?,?,?,?,?,?,?,?)"
        );
        insert.run("a", "anthropic-sub", "aaaa1111-x", "/fixture/a.jsonl", "aaaa1111-x", "First", 2, 0);
        insert.run("a-sub", "anthropic-sub", "agent-1", "/fixture/a/sub.jsonl", "aaaa1111-x", null, 3, 1);
        insert.run("b", "anthropic-sub", "bbbb2222-y", "/fixture/b.jsonl", "bbbb2222-y", "Second", 5, 0);
        insert.run("c", "openai-sub", "bbbb3333-z", "/fixture/c.jsonl", "bbbb3333-z", null, 4, 0);
        db.close();
        const path = world.databases.candidate;

        expect(resolveCachedSessionId({ path, id: "aaaa1111-x" })).toEqual({ kind: "exact", sessionId: "aaaa1111-x" });
        expect(resolveCachedSessionId({ path, id: "aaaa" })).toMatchObject({
            kind: "unique",
            sessionId: "aaaa1111-x",
            match: { title: "First" },
        });
        const ambiguous = resolveCachedSessionId({ path, id: "bbbb" });
        expect(ambiguous.kind).toBe("ambiguous");
        expect(ambiguous.kind === "ambiguous" && ambiguous.candidates.map((row) => row.sessionId)).toEqual([
            "bbbb2222-y",
            "bbbb3333-z",
        ]);
        expect(resolveCachedSessionId({ path, id: "cccc" })).toEqual({ kind: "none" });
        expect(resolveCachedSessionId({ path: join(world.root, "absent.db"), id: "aaaa" })).toEqual({
            kind: "unavailable",
            sessionId: "aaaa",
        });
    } finally {
        await world.dispose();
    }
});

test("recent sessions come newest first, main sessions of one provider only", async () => {
    const world = await createFixtureWorld();
    const db = new Database(world.databases.candidate);

    try {
        initializeCompactHistorySchema(db);
        const insert = db.prepare(
            "INSERT INTO session_metadata(source_key,provider,native_id,file_path,session_id,custom_title,mtime,is_subagent) VALUES (?,?,?,?,?,?,?,?)"
        );
        insert.run("old", "anthropic-sub", "old", "/fixture/old.jsonl", "old", "Older", 1, 0);
        insert.run("new", "anthropic-sub", "new", "/fixture/new.jsonl", "new", "Newer", 9, 0);
        insert.run("sub", "anthropic-sub", "agent-1", "/fixture/new/sub.jsonl", "sub-only", null, 10, 1);
        insert.run("codex", "openai-sub", "codex", "/fixture/codex.jsonl", "codex", null, 11, 0);
        db.close();

        const rows = listRecentCachedSessions({
            path: world.databases.candidate,
            providerId: "anthropic-sub",
            limit: 5,
        });
        expect(rows.map((row) => [row.sessionId, row.title])).toEqual([
            ["new", "Newer"],
            ["old", "Older"],
        ]);
    } finally {
        await world.dispose();
    }
});

test("an index that cannot answer is unavailable to the id lookup and empty to the picker", async () => {
    const world = await createFixtureWorld();
    const noTable = join(world.root, "no-table.db");
    const oldColumns = join(world.root, "old-columns.db");

    try {
        const bare = new Database(noTable);
        bare.run("CREATE TABLE other(x TEXT)");
        bare.close();
        const old = new Database(oldColumns);
        old.run("CREATE TABLE session_metadata(session_id TEXT, mtime INTEGER, custom_title TEXT)");
        old.run("INSERT INTO session_metadata VALUES ('aaaa1111-x', 1, 'First')");
        old.close();

        for (const path of [noTable, oldColumns]) {
            expect(resolveCachedSessionId({ path, id: "aaaa" })).toEqual({ kind: "unavailable", sessionId: "aaaa" });
            expect(listRecentCachedSessions({ path, providerId: "anthropic-sub", limit: 5 })).toEqual([]);
        }
    } finally {
        await world.dispose();
    }
});

test("a session's folder comes from the index: exact id first, main over subagent, then newest", async () => {
    const world = await createFixtureWorld();
    const db = new Database(world.databases.candidate);

    try {
        expect(readCachedSessionCwd({ path: join(world.root, "absent", "index.db"), sessionId: "abc" })).toBeNull();
        initializeCompactHistorySchema(db);
        const insert = db.prepare(
            "INSERT INTO session_metadata(source_key,provider,native_id,file_path,session_id,cwd,mtime,is_subagent) VALUES (?,?,?,?,?,?,?,?)"
        );
        insert.run("main", "anthropic-sub", "abc-1", "/fixture/abc-1.jsonl", "abc-1", "/projects/main", 1, 0);
        insert.run("child", "anthropic-sub", "abc-1-child", "/fixture/c.jsonl", "abc-1", "/projects/child", 9, 1);
        insert.run("newer", "openai-sub", "abc-2", "/fixture/abc-2.jsonl", "abc-2", "/projects/newer", 5, 0);
        insert.run("empty", "grok-sub", "zzz", "/fixture/zzz.jsonl", "zzz", "", 7, 0);
        db.close();

        const path = world.databases.candidate;
        expect(readCachedSessionCwd({ path, sessionId: "abc-1" })).toBe("/projects/main");
        // A prefix takes the newest main session it names.
        expect(readCachedSessionCwd({ path, sessionId: "abc" })).toBe("/projects/newer");
        expect(readCachedSessionCwd({ path, sessionId: "zzz" })).toBeNull();
        expect(readCachedSessionCwd({ path, sessionId: "nothing" })).toBeNull();
    } finally {
        await world.dispose();
    }
});
