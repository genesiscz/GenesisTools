import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    appendControlRequest,
    ControlLogCursor,
    readControlRequests,
    respondToControl,
    sendControlRequest,
    waitForControlResponse,
} from "./control-channel";
import { sessionControlPath } from "./paths";
import { CodexSessionStore } from "./store";

describe("codex control channel", () => {
    test("orders requests and round-trips responses", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const first = await appendControlRequest("reviewer", "launch-1", { op: "interrupt" });
            const second = await appendControlRequest("reviewer", "launch-1", { op: "rollback", turns: 2 });

            const requests = await readControlRequests("reviewer", 0);
            expect(requests.map((request) => request.seq)).toEqual([1, 2]);
            expect(requests.map((request) => request.control)).toEqual([
                { op: "interrupt" },
                { op: "rollback", turns: 2 },
            ]);

            const responsePromise = waitForControlResponse("reviewer", second.id, 1_000);
            respondToControl("reviewer", second.id, { ok: true, result: { rolledBack: 2 } });
            await expect(responsePromise).resolves.toEqual({ ok: true, result: { rolledBack: 2 } });
            expect(first.seq).toBe(1);
        });
    });

    test("keeps controls from an earlier launch generation inert", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-generation-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await appendControlRequest("reviewer", "old-launch", { op: "steer", body: "stale", force: false });
            await appendControlRequest("reviewer", "old-launch", { op: "stop" });
            const current = await appendControlRequest("reviewer", "new-launch", {
                op: "steer",
                body: "current",
                force: false,
            });

            const requests = await readControlRequests("reviewer", 0, "new-launch");

            expect(requests).toEqual([current]);
            expect(requests[0]?.control).toEqual({ op: "steer", body: "current", force: false });
        });
    });

    test("the daemon cursor parses only appended bytes and no history on an unchanged tick", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-cursor-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await appendControlRequest("reviewer", "old-launch", { op: "interrupt" });
            const first = await appendControlRequest("reviewer", "current-launch", {
                op: "steer",
                body: "first",
                force: false,
            });
            const samples: Array<{ bytes: number; records: number }> = [];
            const cursor = new ControlLogCursor({
                name: "reviewer",
                generation: "current-launch",
                onRead: (sample) => samples.push(sample),
            });

            expect(await cursor.readAppendedRequests()).toEqual([first]);
            const afterFirstRead = [...samples];
            expect(await cursor.readAppendedRequests()).toEqual([]);
            expect(samples).toEqual(afterFirstRead);

            const second = await appendControlRequest("reviewer", "current-launch", {
                op: "steer",
                body: "second",
                force: false,
            });
            expect(await cursor.readAppendedRequests()).toEqual([second]);
            expect(samples.at(-1)?.records).toBe(1);
            expect(samples.at(-1)?.bytes ?? Number.POSITIVE_INFINITY).toBeLessThan(
                statSync(sessionControlPath("reviewer")).size
            );
        });
    });

    test("the daemon cursor reads a record larger than one read chunk and skips other generations", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-cursor-chunks-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await appendControlRequest("reviewer", "old-launch", {
                op: "steer",
                body: "o".repeat(70_000),
                force: false,
            });
            const current = await appendControlRequest("reviewer", "current-launch", {
                op: "steer",
                body: "c".repeat(150_000),
                force: false,
            });
            const cursor = new ControlLogCursor({ name: "reviewer", generation: "current-launch" });

            expect(await cursor.readAppendedRequests()).toEqual([current]);
            expect(await cursor.readAppendedRequests()).toEqual([]);
        });
    });

    test("the daemon cursor retains a partial line and recovers after truncation", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-cursor-recovery-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const path = sessionControlPath("reviewer");
            const cursor = new ControlLogCursor({ name: "reviewer", generation: "current-launch" });
            const first = await appendControlRequest("reviewer", "current-launch", { op: "interrupt" });
            expect(await cursor.readAppendedRequests()).toEqual([first]);

            const second = {
                id: "second",
                generation: "current-launch",
                seq: 2,
                ts: new Date().toISOString(),
                control: { op: "read" as const },
            };
            const secondLine = `${SafeJSON.stringify(second, { jsonl: true })}\n`;
            appendFileSync(path, secondLine.slice(0, 20));
            expect(await cursor.readAppendedRequests()).toEqual([]);
            appendFileSync(path, secondLine.slice(20));
            expect(await cursor.readAppendedRequests()).toEqual([second]);

            const third = { ...second, id: "third", seq: 3 };
            writeFileSync(path, `${SafeJSON.stringify(third, { jsonl: true })}\n`);
            expect(await cursor.readAppendedRequests()).toEqual([third]);
        });
    });

    test("times out when the daemon does not answer", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-timeout-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            await expect(waitForControlResponse("missing", "request-1", 20)).rejects.toThrow("Timed out");
        });
    });

    test("rejects controls for closed sessions without waiting for a timeout", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-closed-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const now = new Date().toISOString();
            store.writeMeta({
                name: "reviewer",
                daemonPid: 123,
                cwd: "/repo",
                sandbox: "read-only",
                approvalPolicy: "never",
                writePolicy: "deny",
                status: "closed",
                agentName: "codex_reviewer",
                rendezvousSession: "parent",
                agentsEnabled: false,
                startedAt: now,
                lastEventAt: now,
                codexVersion: "0.144.5",
                pendingApprovals: {},
            });

            await expect(sendControlRequest("reviewer", { op: "interrupt" }, 20)).rejects.toThrow(
                'Codex session "reviewer" is closed'
            );
        });
    });
});
