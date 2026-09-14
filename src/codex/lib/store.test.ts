import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { WorkerNameTakenError } from "@genesiscz/utils/worker/meta-store";
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

            expect(store.readMeta("reviewer")).toEqual(meta);
            expect(store.listNames()).toEqual(["reviewer"]);
        });
    });

    test("exactly one of two concurrent claims on one name wins", async () => {
        // The bug the shared store fixes. The hand-written copy read, then wrote: two
        // `tools codex spawn --name reviewer` in flight together both saw the name as free,
        // both started a daemon, and the second record overwrote the first — whose pid nothing
        // then pointed at. O_EXCL makes the check and the write one syscall.
        const home = mkdtempSync(join(tmpdir(), "gt-codex-claim-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const outcomes = await Promise.allSettled([
                Promise.resolve().then(() => store.createMeta({ ...makeMeta(Date.now()), daemonPid: 111 })),
                Promise.resolve().then(() => store.createMeta({ ...makeMeta(Date.now()), daemonPid: 222 })),
            ]);

            expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
            const rejected = outcomes.find((outcome) => outcome.status === "rejected");
            expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(WorkerNameTakenError);
            expect((rejected as PromiseRejectedResult).reason.message).toMatch(/already exists/);
            expect(store.listNames()).toEqual(["reviewer"]);
        });
    });

    test("listNames does not create the sessions directory", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-list-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
            // `sessions` and `status` are diagnostics. Inspecting codex must not leave a
            // directory behind; the copied store used to mkdir on every listing.
            expect(new CodexSessionStore().listNames()).toEqual([]);
            expect(existsSync(join(home, ".genesis-tools", "codex", "sessions"))).toBe(false);
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

    test("rejects unsafe session names", () => {
        const store = new CodexSessionStore();
        expect(() => store.readMeta("../escape")).toThrow("Invalid session name");
        expect(() => store.readMeta("nested/name")).toThrow("Invalid session name");
    });
});
