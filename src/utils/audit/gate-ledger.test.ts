import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import type { RmRequest } from "@genesiscz/utils/rm/requests";
import { readGateLedger } from "./gate-ledger";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const APP = { app: "com.example.app", executable: "/Applications/Example.app", pid: 0 };

function line(fields: Record<string, unknown>, pid: number, secondsAgo: number, app = true): string {
    const at = new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
    const writer = app ? { ...APP, pid } : { pid, argv: ["tools", "ai"] };
    return SafeJSON.stringify({ ...fields, at, writer });
}

function rmRequest(id: string, overrides: Partial<RmRequest> = {}): RmRequest {
    return {
        id,
        kind: "delete",
        createdAt: "2026-11-04T11:00:00.000Z",
        caller: { agent: "claude", sessionId: "s-1", isInAgent: true, sessionTitle: "fix the build" },
        cwd: "/tmp/project",
        reason: "old build output",
        targets: [{ path: "/tmp/project/out", kind: "dir", rule: "ask", reason: "not a preset", bytes: 2048 }],
        status: "pending",
        ...overrides,
    };
}

describe("readGateLedger", () => {
    test("an open window waits while its writer runs and its deadline has not passed", () => {
        const lines = [
            line(
                { gate: "vault", event: "prompted", client: { name: "deploy script" }, shown: { title: "Unlock" } },
                11,
                30
            ),
            line(
                {
                    gate: "ai-account",
                    event: "prompted",
                    client: { name: "worker" },
                    provider: "openai",
                    account: "work",
                },
                12,
                20
            ),
        ];
        const ledger = readGateLedger({
            lines: () => lines,
            rmRequests: () => [],
            isWriterAlive: () => true,
            now: NOW,
        });

        expect(ledger.pending.map((wait) => wait.id)).toEqual(["vault:11", "ai-account:12"]);
        expect(ledger.pending[0]).toMatchObject({ title: "Unlock", who: "deploy script", window: { pid: 11 } });
        expect(ledger.pending[0].window?.deadline).toBe("2026-11-04T12:02:20.000Z");
        expect(ledger.pending[1]).toMatchObject({ account: "work", provider: "openai" });
    });

    test("a decided, expired or dead window does not wait, and a decision reads as history", () => {
        const lines = [
            line({ gate: "vault", event: "prompted", client: { name: "a" } }, 21, 60),
            line({ gate: "vault", event: "allowed", client: { name: "a" } }, 21, 50),
            line({ gate: "vault", event: "prompted", client: { name: "b" } }, 22, 200),
            line({ gate: "vault", event: "prompted", client: { name: "c" } }, 23, 10),
        ];
        const ledger = readGateLedger({
            lines: () => lines,
            rmRequests: () => [],
            isWriterAlive: (pid) => pid !== 23,
            now: NOW,
        });

        expect(ledger.pending).toEqual([]);
        expect(ledger.recent).toEqual([
            { gate: "vault", event: "allowed", at: "2026-11-04T11:59:10.000Z", who: "a", title: "Vault unlock" },
        ]);
    });

    test("a TypeScript double line neither opens nor closes a window", () => {
        const lines = [
            line({ gate: "ai-account", event: "prompted", client: { name: "worker" } }, 31, 20),
            line({ gate: "ai-account", event: "denied", client: { name: "worker" } }, 31, 10, false),
        ];
        const ledger = readGateLedger({
            lines: () => lines,
            rmRequests: () => [],
            isWriterAlive: () => true,
            now: NOW,
        });

        expect(ledger.pending.map((wait) => wait.id)).toEqual(["ai-account:31"]);
        expect(ledger.recent).toEqual([]);
    });

    test("a pending rm request merges with its open window, and one without a window stays listed", () => {
        const lines = [line({ gate: "rm", event: "prompted", title: "Delete out", request: "abc" }, 41, 15)];
        const ledger = readGateLedger({
            lines: () => lines,
            rmRequests: () => [rmRequest("abc"), rmRequest("def", { createdAt: "2026-11-04T11:30:00.000Z" })],
            isWriterAlive: () => true,
            now: NOW,
        });

        expect(ledger.pending.map((wait) => [wait.id, wait.window?.pid ?? null])).toEqual([
            ["rm:abc", 41],
            ["rm:def", null],
        ]);
        expect(ledger.pending[0]).toMatchObject({
            title: "Delete /tmp/project/out",
            who: "fix the build",
            request: { reason: "old build output", paths: [{ path: "/tmp/project/out", bytes: 2048 }] },
        });
        expect(ledger.pending[0].request?.expiresAt).toBe("2026-11-05T11:00:00.000Z");
    });

    test("an rm request whose files wait aside never expires", () => {
        const ledger = readGateLedger({
            lines: () => [],
            rmRequests: () => [rmRequest("abc", { asideDir: "/tmp/project/.rm-aside/abc" })],
            isWriterAlive: () => true,
            now: NOW,
        });

        expect(ledger.pending[0].request?.expiresAt).toBeNull();
    });

    test("a gate that waits on no person and a line that is not JSON are skipped", () => {
        const lines = ["not json", line({ gate: "privacy-permission", event: "prompted" }, 51, 5)];
        const ledger = readGateLedger({
            lines: () => lines,
            rmRequests: () => [],
            isWriterAlive: () => true,
            now: NOW,
        });

        expect(ledger).toEqual({ pending: [], recent: [] });
    });
});
