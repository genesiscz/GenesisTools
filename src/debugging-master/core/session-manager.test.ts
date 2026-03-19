import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DebugMasterConfig } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";
import { ConfigManager } from "./config-manager";
import { ACTIVE_THRESHOLD_MS, SessionManager } from "./session-manager";

function createTestSessionManager(sessionsDir: string): SessionManager {
    const configManager = new ConfigManager();

    // Override getSessionsDir to return our temp directory
    configManager.getSessionsDir = () => sessionsDir;

    // Stub config persistence methods to avoid touching real config
    let recentSession: string | null = null;
    const config: DebugMasterConfig = { projects: {} };

    configManager.setRecentSession = async (name: string) => {
        recentSession = name;
        config.recentSession = name;
    };

    configManager.getRecentSession = async () => recentSession;

    configManager.load = async () => config;

    configManager.save = async () => {};

    return new SessionManager(configManager);
}

describe("SessionManager", () => {
    let tempDir: string;
    let sm: SessionManager;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "dbg-master-test-"));
        sm = createTestSessionManager(tempDir);
    });

    afterEach(() => {
        if (existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe("ACTIVE_THRESHOLD_MS", () => {
        it("is 2 hours", () => {
            expect(ACTIVE_THRESHOLD_MS).toBe(2 * 60 * 60 * 1000);
        });
    });

    describe("createSession", () => {
        it("creates both .jsonl and .meta.json files", async () => {
            await sm.createSession("test-session", "/tmp/project");

            const files = readdirSync(tempDir);
            expect(files).toContain("test-session.jsonl");
            expect(files).toContain("test-session.meta.json");
        });

        it("writes valid meta JSON with expected fields", async () => {
            const before = Date.now();
            await sm.createSession("my-session", "/home/user/project");
            const after = Date.now();

            const meta = await sm.getSessionMeta("my-session");
            expect(meta).not.toBeNull();
            expect(meta!.name).toBe("my-session");
            expect(meta!.projectPath).toBe("/home/user/project");
            expect(meta!.createdAt).toBeGreaterThanOrEqual(before);
            expect(meta!.createdAt).toBeLessThanOrEqual(after);
            expect(meta!.lastActivityAt).toBeGreaterThanOrEqual(before);
            expect(meta!.lastActivityAt).toBeLessThanOrEqual(after);
        });

        it("creates an empty .jsonl file", async () => {
            await sm.createSession("empty-session", "/tmp/project");
            const jsonlPath = join(tempDir, "empty-session.jsonl");
            const content = await Bun.file(jsonlPath).text();
            expect(content).toBe("");
        });

        it("throws if session already exists", async () => {
            await sm.createSession("dup", "/tmp/project");
            expect(sm.createSession("dup", "/tmp/project")).rejects.toThrow("already exists");
        });
    });

    describe("listSessionNames", () => {
        it("returns empty array when no sessions exist", async () => {
            const names = await sm.listSessionNames();
            expect(names).toEqual([]);
        });

        it("returns created session names", async () => {
            await sm.createSession("alpha", "/tmp/a");
            await sm.createSession("beta", "/tmp/b");

            const names = await sm.listSessionNames();
            expect(names).toContain("alpha");
            expect(names).toContain("beta");
            expect(names.length).toBe(2);
        });

        it("does not include meta files in the list", async () => {
            await sm.createSession("sess", "/tmp/p");
            const names = await sm.listSessionNames();
            for (const name of names) {
                expect(name).not.toContain(".meta");
            }
        });
    });

    describe("deleteSession", () => {
        it("removes both .jsonl and .meta.json and returns true", async () => {
            await sm.createSession("to-delete", "/tmp/project");

            const result = await sm.deleteSession("to-delete");
            expect(result).toBe(true);

            expect(existsSync(join(tempDir, "to-delete.jsonl"))).toBe(false);
            expect(existsSync(join(tempDir, "to-delete.meta.json"))).toBe(false);
        });

        it("returns false for non-existent session", async () => {
            const result = await sm.deleteSession("does-not-exist");
            expect(result).toBe(false);
        });

        it("removes session from listSessionNames after deletion", async () => {
            await sm.createSession("ephemeral", "/tmp/project");
            expect(await sm.listSessionNames()).toContain("ephemeral");

            await sm.deleteSession("ephemeral");
            expect(await sm.listSessionNames()).not.toContain("ephemeral");
        });
    });

    describe("getInactiveSessions", () => {
        it("returns sessions older than threshold", async () => {
            await sm.createSession("old-session", "/tmp/project");

            // Manually set lastActivityAt to 48 hours ago
            const metaPath = join(tempDir, "old-session.meta.json");
            const meta = await Bun.file(metaPath).json();
            meta.lastActivityAt = Date.now() - 48 * 60 * 60 * 1000;
            await Bun.write(metaPath, SafeJSON.stringify(meta, null, "\t"));

            const inactive = await sm.getInactiveSessions();
            expect(inactive.length).toBe(1);
            expect(inactive[0].name).toBe("old-session");
        });

        it("does not return recently active sessions", async () => {
            await sm.createSession("fresh-session", "/tmp/project");

            const inactive = await sm.getInactiveSessions();
            expect(inactive.length).toBe(0);
        });

        it("respects custom threshold", async () => {
            await sm.createSession("mid-session", "/tmp/project");

            // Set lastActivityAt to 5 minutes ago
            const metaPath = join(tempDir, "mid-session.meta.json");
            const meta = await Bun.file(metaPath).json();
            meta.lastActivityAt = Date.now() - 5 * 60 * 1000;
            await Bun.write(metaPath, SafeJSON.stringify(meta, null, "\t"));

            // With 1-minute threshold, session should be inactive
            const inactive = await sm.getInactiveSessions(60 * 1000);
            expect(inactive.length).toBe(1);

            // With 10-minute threshold, session should still be active
            const stillActive = await sm.getInactiveSessions(10 * 60 * 1000);
            expect(stillActive.length).toBe(0);
        });
    });

    describe("getActiveSessions", () => {
        it("returns sessions within the active threshold", async () => {
            await sm.createSession("active-sess", "/tmp/project");

            const active = await sm.getActiveSessions();
            expect(active.length).toBe(1);
            expect(active[0].name).toBe("active-sess");
        });

        it("does not return sessions outside the active threshold", async () => {
            await sm.createSession("stale-sess", "/tmp/project");

            // Set lastActivityAt to 3 hours ago (beyond ACTIVE_THRESHOLD_MS of 2h)
            const metaPath = join(tempDir, "stale-sess.meta.json");
            const meta = await Bun.file(metaPath).json();
            meta.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000;
            await Bun.write(metaPath, SafeJSON.stringify(meta, null, "\t"));

            const active = await sm.getActiveSessions();
            expect(active.length).toBe(0);
        });

        it("returns empty array when no sessions exist", async () => {
            const active = await sm.getActiveSessions();
            expect(active).toEqual([]);
        });
    });
});
