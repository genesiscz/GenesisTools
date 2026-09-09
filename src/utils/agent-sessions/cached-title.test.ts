import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCachedHistoryTitle } from "./cached-title";
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
