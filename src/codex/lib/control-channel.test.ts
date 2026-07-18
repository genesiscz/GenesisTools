import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    appendControlRequest,
    readControlRequests,
    respondToControl,
    sendControlRequest,
    waitForControlResponse,
} from "./control-channel";
import { CodexSessionStore } from "./store";

describe("codex control channel", () => {
    test("orders requests and round-trips responses", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-control-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const first = await appendControlRequest("reviewer", { op: "interrupt" });
            const second = await appendControlRequest("reviewer", { op: "rollback", turns: 2 });

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
