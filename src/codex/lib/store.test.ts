import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { type CodexSessionMeta, CodexSessionStore, deriveSessionStatus } from "./store";

function makeMeta(now: number): CodexSessionMeta {
    return {
        name: "reviewer",
        daemonPid: 123,
        cwd: "/repo",
        sandbox: "read-only",
        approvalPolicy: "never",
        writePolicy: "deny",
        status: "running",
        agentName: "codex_reviewer",
        rendezvousSession: "parent-session",
        agentsEnabled: true,
        startedAt: new Date(now - 5_000).toISOString(),
        lastEventAt: new Date(now - 1_000).toISOString(),
        codexVersion: "0.144.5",
        pendingApprovals: {},
    };
}

describe("CodexSessionStore", () => {
    test("persists metadata atomically and lists sessions", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-store-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(Date.now());
            store.writeMeta(meta);

            await expect(store.readMeta("reviewer")).resolves.toEqual(meta);
            await expect(store.listNames()).resolves.toEqual(["reviewer"]);
        });
    });

    test("appends structured events in order", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-events-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            store.appendEvent("reviewer", { source: "app-server", method: "turn/started", params: { id: "t1" } });
            store.appendEvent("reviewer", { source: "control", method: "steer", params: { body: "focus" } });

            const events = await store.readEvents("reviewer");
            expect(events.map((event) => event.seq)).toEqual([1, 2]);
            expect(events.map((event) => event.method)).toEqual(["turn/started", "steer"]);
        });
    });

    test("derives stalled and closed states without mutating persisted state", () => {
        const now = Date.now();
        const meta = makeMeta(now);
        expect(deriveSessionStatus(meta, now, 10_000)).toBe("running");
        expect(deriveSessionStatus({ ...meta, lastEventAt: new Date(now - 20_000).toISOString() }, now, 10_000)).toBe(
            "stalled"
        );
        expect(deriveSessionStatus({ ...meta, status: "closed" }, now, 10_000)).toBe("closed");
    });

    test("rejects unsafe session names", async () => {
        const store = new CodexSessionStore();
        await expect(store.readMeta("../escape")).rejects.toThrow("Invalid session name");
        await expect(store.readMeta("nested/name")).rejects.toThrow("Invalid session name");
    });
});
