import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { RpcClient } from "./session";
import { CodexSessionRuntime } from "./session";
import { type CodexSessionMeta, CodexSessionStore } from "./store";

class FakeRpcClient implements RpcClient {
    readonly requests: Array<{ method: string; params: unknown }> = [];
    readonly notifications: Array<{ method: string; params: unknown }> = [];
    private turn = 0;
    rejectNextTurn: Error | null = null;

    async request<T>(method: string, params?: unknown): Promise<T> {
        this.requests.push({ method, params });

        if (method === "initialize") {
            return {} as T;
        }

        if (method === "thread/start") {
            return { thread: { id: "thread-1" } } as T;
        }

        if (method === "turn/start") {
            if (this.rejectNextTurn) {
                const error = this.rejectNextTurn;
                this.rejectNextTurn = null;
                throw error;
            }

            this.turn += 1;
            return { turn: { id: `turn-${this.turn}` } } as T;
        }

        if (method === "turn/interrupt" || method === "thread/rollback" || method === "thread/unsubscribe") {
            return {} as T;
        }

        if (method === "thread/read") {
            return { thread: { id: "thread-1", turns: [] } } as T;
        }

        if (method === "review/start") {
            return { turn: { id: "review-turn-1" }, reviewThreadId: "thread-1" } as T;
        }

        throw new Error(`Unexpected request: ${method}`);
    }

    async notify(method: string, params?: unknown): Promise<void> {
        this.notifications.push({ method, params });
    }

    async close(): Promise<void> {}
}

function makeMeta(home: string): CodexSessionMeta {
    const now = new Date().toISOString();
    return {
        name: "reviewer",
        daemonPid: 123,
        cwd: "/repo",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        writePolicy: "allow",
        status: "starting",
        agentName: "codex_reviewer",
        rendezvousSession: "parent-123",
        agentsEnabled: true,
        startedAt: now,
        lastEventAt: now,
        codexVersion: "0.144.5",
        pendingApprovals: {},
        home,
    };
}

describe("CodexSessionRuntime", () => {
    test("handshakes, starts a thread, and fires the first turn with exact v0.144 input", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });

            await runtime.start({ prompt: "Review the auth path" });

            expect(client.requests.map((request) => request.method)).toEqual([
                "initialize",
                "thread/start",
                "turn/start",
            ]);
            expect(client.notifications).toEqual([{ method: "initialized", params: undefined }]);
            expect(client.requests[1]?.params).toMatchObject({
                cwd: "/repo",
                sandbox: "workspace-write",
                approvalPolicy: "never",
                developerInstructions: expect.stringContaining("--session parent-123"),
            });
            expect(client.requests[2]?.params).toEqual({
                threadId: "thread-1",
                input: [{ type: "text", text: "Review the auth path", text_elements: [] }],
            });

            const persisted = await store.readMeta("reviewer");
            expect(persisted?.threadId).toBe("thread-1");
            expect(persisted?.activeTurnId).toBe("turn-1");
            expect(persisted?.status).toBe("running");
        });
    });

    test("tracks turn lifecycle and usage from notifications", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-events-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const runtime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta });
            await runtime.start({});

            await runtime.handleNotification({ method: "turn/started", params: { turn: { id: "turn-9" } } });
            await runtime.handleNotification({
                method: "thread/tokenUsage/updated",
                params: { tokenUsage: { total: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 } } },
            });
            await runtime.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-9" } } });

            const persisted = await store.readMeta("reviewer");
            expect(persisted?.status).toBe("ready");
            expect(persisted?.activeTurnId).toBeUndefined();
            expect(persisted?.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 });
            expect((await store.readEvents("reviewer")).map((event) => event.method)).toEqual([
                "daemon/started",
                "turn/started",
                "thread/tokenUsage/updated",
                "turn/completed",
            ]);
        });
    });

    test("steers the active turn by re-submitting turn/start", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-steer-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });

            const result = await runtime.execute({ op: "steer", body: "Focus on auth", force: false });

            // codex 0.144.5 merges mid-turn input into the ACTIVE turn (verified
            // live): the phantom new turn id is reported, but meta keeps the
            // original active turn.
            expect(result).toEqual({ turnId: "turn-2", queued: false, merged: true });
            expect((await store.readMeta("reviewer"))?.activeTurnId).toBe("turn-1");
            expect(client.requests.at(-1)).toEqual({
                method: "turn/start",
                params: {
                    threadId: "thread-1",
                    input: [{ type: "text", text: "Focus on auth", text_elements: [] }],
                },
            });
        });
    });

    test("queues a rejected same-turn steer and delivers it at the boundary", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-queue-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });
            client.rejectNextTurn = new Error("active turn cannot accept same-turn steering");

            await expect(runtime.execute({ op: "steer", body: "Queued correction", force: false })).resolves.toEqual({
                queued: true,
            });
            await runtime.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-1" } } });

            expect(client.requests.at(-1)?.method).toBe("turn/start");
            expect(client.requests.at(-1)?.params).toMatchObject({
                input: [{ type: "text", text: "Queued correction", text_elements: [] }],
            });
            expect((await store.readMeta("reviewer"))?.queuedSteers).toEqual([]);
        });
    });

    test("interrupts, rolls back, and reads the thread", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-controls-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });

            await runtime.execute({ op: "interrupt" });
            await runtime.execute({ op: "rollback", turns: 2 });
            const snapshot = await runtime.execute({ op: "read" });

            expect(client.requests.slice(-3)).toEqual([
                { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
                { method: "thread/rollback", params: { threadId: "thread-1", numTurns: 2 } },
                { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
            ]);
            expect(snapshot).toEqual({ thread: { id: "thread-1", turns: [] } });
        });
    });

    test("starts native and adversarial reviews", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-review-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({});

            await runtime.execute({ op: "review", scope: "working-tree" });
            await runtime.execute({ op: "review", scope: "branch", base: "main", adversarial: ["auth", "rollback"] });

            expect(client.requests.at(-2)).toEqual({
                method: "review/start",
                params: { threadId: "thread-1", target: { type: "uncommittedChanges" } },
            });
            expect(client.requests.at(-1)?.method).toBe("turn/start");
            expect(client.requests.at(-1)?.params).toMatchObject({
                input: [
                    {
                        type: "text",
                        text: expect.stringContaining("auth, rollback"),
                        text_elements: [],
                    },
                ],
            });
        });
    });

    test("auto-answers approval requests for allow and deny policies", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-auto-approval-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const allowMeta = makeMeta(home);
            store.writeMeta(allowMeta);
            const allowRuntime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta: allowMeta });
            await expect(
                allowRuntime.handleServerRequest({
                    id: "allow-1",
                    method: "item/fileChange/requestApproval",
                    params: { itemId: "item-1" },
                })
            ).resolves.toEqual({ decision: "accept" });

            const denyMeta = { ...makeMeta(home), name: "deny", writePolicy: "deny" as const };
            store.writeMeta(denyMeta);
            const denyRuntime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta: denyMeta });
            await expect(
                denyRuntime.handleServerRequest({
                    id: "deny-1",
                    method: "item/commandExecution/requestApproval",
                    params: { command: "touch x" },
                })
            ).resolves.toEqual({ decision: "decline" });
        });
    });

    test("holds ask approvals until an approve control resolves them", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-ask-approval-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = {
                ...makeMeta(home),
                writePolicy: "ask" as const,
                approvalPolicy: "untrusted" as const,
            };
            store.writeMeta(meta);
            const notices: Array<Record<string, unknown>> = [];
            const runtime = new CodexSessionRuntime({
                client: new FakeRpcClient(),
                store,
                meta,
                onApprovalRequest: async (notice) => {
                    notices.push(notice);
                },
            });

            const pending = runtime.handleServerRequest({
                id: "request-1",
                method: "item/fileChange/requestApproval",
                params: { itemId: "item-1", reason: "write src/x.ts" },
            });
            await Bun.sleep(10);

            expect(notices).toEqual([expect.objectContaining({ event: "approval_request", requestId: "request-1" })]);
            expect((await store.readMeta("reviewer"))?.pendingApprovals["request-1"]).toMatchObject({
                method: "item/fileChange/requestApproval",
            });

            await runtime.execute({ op: "approve", requestId: "request-1" });
            await expect(pending).resolves.toEqual({ decision: "accept" });
            expect((await store.readMeta("reviewer"))?.pendingApprovals).toEqual({});
        });
    });

    test("declines and clears unresolved approvals while closing", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-close-approval-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = {
                ...makeMeta(home),
                writePolicy: "ask" as const,
                approvalPolicy: "untrusted" as const,
            };
            store.writeMeta(meta);
            const runtime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta });
            await runtime.start({});
            const pending = runtime.handleServerRequest({
                id: "request-1",
                method: "item/commandExecution/requestApproval",
                params: { command: "touch x" },
            });
            await Bun.sleep(0);

            await runtime.close();

            await expect(pending).resolves.toEqual({ decision: "decline" });
            expect((await store.readMeta("reviewer"))?.pendingApprovals).toEqual({});
        });
    });
});
