import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSessionManager } from "../ChatSessionManager";

describe("ChatSessionManager", () => {
    let tempDir: string;
    let manager: ChatSessionManager;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "ai-chat-test-"));
        manager = new ChatSessionManager({ dir: tempDir });
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("create() returns a session with generated UUID", () => {
        const session = manager.create();
        expect(session.id).toBeTruthy();
        expect(session.id.length).toBeGreaterThan(10); // UUID format
        expect(session.length).toBe(0);
    });

    it("create(id) uses provided ID", () => {
        const session = manager.create("my-session");
        expect(session.id).toBe("my-session");
    });

    it("save and load roundtrip preserves entries", async () => {
        const session = manager.create("roundtrip-test");
        session.add({ role: "user", content: "hello" });
        session.add({ role: "assistant", content: "hi there!" });
        await manager.save(session);

        const loaded = await manager.load("roundtrip-test");
        expect(loaded.length).toBe(2);
        const entries = loaded.getAllEntries();
        expect(entries[0].type).toBe("user");

        if (entries[0].type === "user") {
            expect(entries[0].content).toBe("hello");
        }

        if (entries[1].type === "assistant") {
            expect(entries[1].content).toBe("hi there!");
        }
    });

    it("session.save() works through manager reference", async () => {
        const session = manager.create("delegate-test");
        session.add({ role: "user", content: "test" });
        await session.save(); // should delegate to manager

        const loaded = await manager.load("delegate-test");
        expect(loaded.length).toBe(1);
    });

    it("load non-existent session throws", async () => {
        expect(manager.load("non-existent")).rejects.toThrow("Session not found");
    });

    it("list() returns sessions sorted by last activity", async () => {
        const s1 = manager.create("session-a");
        s1.add({ role: "user", content: "first" });
        await manager.save(s1);

        // Small delay to ensure different timestamps
        await new Promise((r) => setTimeout(r, 10));

        const s2 = manager.create("session-b");
        s2.add({ role: "user", content: "second" });
        await manager.save(s2);

        const list = await manager.list();
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe("session-b"); // most recent first
        expect(list[1].id).toBe("session-a");
    });

    it("delete() removes the session file", async () => {
        const session = manager.create("delete-me");
        session.add({ role: "user", content: "temp" });
        await manager.save(session);

        expect(await manager.exists("delete-me")).toBe(true);
        await manager.delete("delete-me");
        expect(await manager.exists("delete-me")).toBe(false);
    });

    it("exists() returns false for non-existent session", async () => {
        expect(await manager.exists("ghost")).toBe(false);
    });

    it("rejects session IDs with path traversal characters", () => {
        expect(() => manager.create("../etc/passwd")).toThrow("Invalid session ID");
        expect(() => manager.create("foo/bar")).toThrow("Invalid session ID");
        expect(() => manager.create("foo bar")).toThrow("Invalid session ID");
    });

    it("accepts valid session IDs with hyphens and underscores", () => {
        const session = manager.create("my-session_123");
        expect(session.id).toBe("my-session_123");
    });
});
