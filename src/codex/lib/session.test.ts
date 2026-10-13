import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ThreadTurnsListParams, Turn } from "./_generated/protocol";
import { CodexAccountBinding } from "./account";
import { isOwnBusCommand } from "./bus-approval";
import type { RpcClient } from "./session";
import { CodexSessionRuntime } from "./session";
import { type CodexSessionMeta, CodexSessionStore } from "./store";

class FakeRpcClient implements RpcClient {
    readonly requests: Array<{ method: string; params: unknown }> = [];
    readonly notifications: Array<{ method: string; params: unknown }> = [];
    private turn = 0;
    rejectNextTurn: Error | null = null;
    /** What `thread/list` returns; empty means the thread is not listable yet. */
    threads: Array<{ id: string; projectId?: string | null }> = [];
    /** The thread's turns, oldest first; `thread/turns/list` pages them newest first. */
    turns: Turn[] = [];
    /** The most turns one `thread/turns/list` page holds, whatever limit was asked for. */
    turnPageCap = Number.POSITIVE_INFINITY;
    rejectRevert: Error | null = null;

    async request<T>(method: string, params?: unknown): Promise<T> {
        this.requests.push({ method, params });

        if (method === "initialize") {
            return {} as T;
        }

        if (method === "account/login/start") {
            return { type: "chatgptAuthTokens" } as T;
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

        if (method === "turn/interrupt" || method === "thread/unsubscribe") {
            return {} as T;
        }

        if (method === "thread/turns/list") {
            const { cursor, limit } = params as ThreadTurnsListParams;
            const newestFirst = [...this.turns].reverse();
            const start = cursor ? Number(cursor) : 0;
            const end = start + Math.min(limit ?? newestFirst.length, this.turnPageCap);
            return {
                data: newestFirst.slice(start, end),
                nextCursor: end < newestFirst.length ? String(end) : null,
                backwardsCursor: null,
            } as T;
        }

        if (method === "thread/revert") {
            if (this.rejectRevert) {
                throw this.rejectRevert;
            }

            return {
                thread: { id: "thread-1", turns: [] },
                turnsBackwardsCursor: null,
                itemsBackwardsCursor: null,
            } as T;
        }

        if (method === "thread/read") {
            return { thread: { id: "thread-1", turns: [] } } as T;
        }

        if (method === "review/start") {
            return { turn: { id: "review-turn-1" }, reviewThreadId: "thread-1" } as T;
        }

        if (method === "thread/list") {
            return { data: this.threads } as T;
        }

        if (method === "project/list") {
            return { data: [{ id: "p-tools", name: "Tools", roots: [{ path: "/elsewhere" }] }] } as T;
        }

        if (method === "thread/metadata/update") {
            return {} as T;
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
    test("handshakes, starts a thread, and fires the first turn with exact v0.162 input", async () => {
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

            // codex 0.162.1 merges mid-turn input into the ACTIVE turn (verified
            // live): the returned turn id is reported, but meta keeps the
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

    test("queues a steer turn/start refuses for a non-steerable turn and delivers it at the boundary", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-queue-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });
            // codex-cli 0.162.1 `turn/start` while a review turn runs (turn_processor.rs, NotSubmitted).
            client.rejectNextTurn = new Error(
                "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Review }"
            );

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

    test("delivers a queued steer after a legacy turn failure", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-failed-queue-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });
            // The `turn/steer` form: the structured error data decides, whatever the message says.
            client.rejectNextTurn = Object.assign(new Error("rejected"), {
                data: {
                    message: "cannot steer a compact turn",
                    codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } },
                    additionalDetails: null,
                },
            });

            await expect(
                runtime.execute({ op: "steer", body: "Recover after failure", force: false })
            ).resolves.toEqual({
                queued: true,
            });
            await runtime.handleNotification({ method: "turn/failed", params: { turn: { id: "turn-1" } } });

            expect(client.requests.at(-1)?.params).toMatchObject({
                input: [{ type: "text", text: "Recover after failure", text_elements: [] }],
            });
            expect((await store.readMeta("reviewer"))?.queuedSteers).toEqual([]);
        });
    });

    test("does not queue a steer the server refuses for another reason", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-steer-refused-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });

            for (const message of ["no active turn to steer", "active turn cannot accept same-turn steering"]) {
                client.rejectNextTurn = new Error(message);
                await expect(runtime.execute({ op: "steer", body: "Lost", force: false })).rejects.toThrow(message);
            }

            expect((await store.readMeta("reviewer"))?.queuedSteers).toBeUndefined();
        });
    });

    test("interrupts, rolls back through thread/revert, and reads the thread", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-controls-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            client.turns = [
                { id: "turn-a", status: "completed" },
                { id: "turn-b", status: "completed" },
                { id: "turn-c", status: "completed" },
            ];
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({ prompt: "Begin" });

            await runtime.execute({ op: "interrupt" });
            const rolledBack = await runtime.execute({ op: "rollback", turns: 2 });
            const snapshot = await runtime.execute({ op: "read" });

            expect(rolledBack).toEqual({ rolledBack: 2 });
            expect(client.requests.slice(-4)).toEqual([
                { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
                {
                    method: "thread/turns/list",
                    params: { threadId: "thread-1", limit: 2, sortDirection: "desc", itemsView: "notLoaded" },
                },
                { method: "thread/revert", params: { threadId: "thread-1", beforeTurnId: "turn-b" } },
                { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
            ]);
            expect(snapshot).toEqual({ thread: { id: "thread-1", turns: [] } });
        });
    });

    test("rollback follows the turn cursor when a page holds fewer turns than asked", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-rollback-pages-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            client.turns = [
                { id: "turn-a", status: "completed" },
                { id: "turn-b", status: "completed" },
                { id: "turn-c", status: "completed" },
            ];
            client.turnPageCap = 2;
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({});

            await expect(runtime.execute({ op: "rollback", turns: 3 })).resolves.toEqual({ rolledBack: 3 });

            const listed = client.requests.filter((request) => request.method === "thread/turns/list");
            expect(listed.map((request) => request.params)).toEqual([
                { threadId: "thread-1", limit: 3, sortDirection: "desc", itemsView: "notLoaded" },
                { threadId: "thread-1", cursor: "2", limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
            ]);
            expect(client.requests.at(-1)).toEqual({
                method: "thread/revert",
                params: { threadId: "thread-1", beforeTurnId: "turn-a" },
            });
        });
    });

    test("refuses to roll back more turns than the thread has, and never reverts", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-rollback-short-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            client.turns = [{ id: "turn-a", status: "completed" }];
            client.rejectRevert = new Error("thread/revert must not be reached");
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({});

            await expect(runtime.execute({ op: "rollback", turns: 2 })).rejects.toThrow(
                "Cannot roll back 2 turn(s): the thread has only 1."
            );
            expect(client.requests.some((request) => request.method === "thread/revert")).toBe(false);
        });
    });

    test("passes the server's revert refusals through unchanged", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-rollback-refused-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            client.turns = [{ id: "turn-a", status: "completed" }];
            const runtime = new CodexSessionRuntime({ client, store, meta });
            await runtime.start({});

            for (const refusal of [
                "thread/revert only supports paginated threads",
                "ephemeral threads do not support thread/revert",
            ]) {
                client.rejectRevert = new Error(refusal);
                await expect(runtime.execute({ op: "rollback", turns: 1 })).rejects.toThrow(refusal);
            }
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

    test("reaches the client reaper when unsubscribe never settles", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-close-timeout-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = { ...makeMeta(home), threadId: "thread-1", status: "ready" as const };
            store.writeMeta(meta);
            let closed = false;
            const client: RpcClient = {
                request: async () => new Promise<never>(() => {}),
                notify: async () => {},
                close: async () => {
                    closed = true;
                },
            };
            const runtime = new CodexSessionRuntime({ client, store, meta, unsubscribeTimeoutMs: 10 });

            await runtime.close();

            expect(closed).toBe(true);
            expect((await store.readMeta("reviewer"))?.status).toBe("closed");
        });
    });
});

test("account-bound workers authenticate before thread start and route refresh outside approval handling", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-account-worker-"));
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
        const token = `e30.${Buffer.from(SafeJSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a" } })).toString("base64url")}.test`;
        const authFile = join(home, "auth.json");
        writeFileSync(
            authFile,
            SafeJSON.stringify({
                tokens: { access_token: token, refresh_token: "never-refresh", account_id: "workspace-a" },
            })
        );
        mkdirSync(join(home, ".genesis-tools/ai"), { recursive: true });
        writeFileSync(
            join(home, ".genesis-tools/ai/config.json"),
            SafeJSON.stringify({
                version: CONFIG_VERSION,
                accounts: [
                    {
                        id: "acc_a",
                        name: "work",
                        provider: "openai-sub",
                        enabled: true,
                        billing: { mode: "subscription" },
                        credentials: { authFile },
                        accountUuid: "workspace-a",
                        useEnvApiKey: false,
                    },
                ],
                defaults: {},
            })
        );
        AiConfigStore.invalidate();
        try {
            const store = new CodexSessionStore();
            const meta = makeMeta(home);
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const runtime = new CodexSessionRuntime({
                client,
                store,
                meta,
                account: await CodexAccountBinding.create("work", { allowRefresh: true }),
            });
            await runtime.start({});
            expect(client.requests.slice(0, 3).map((request) => request.method)).toEqual([
                "initialize",
                "account/login/start",
                "thread/start",
            ]);
            await expect(
                runtime.handleServerRequest({
                    id: 1,
                    method: "account/chatgptAuthTokens/refresh",
                    params: { previousAccountId: "workspace-b" },
                })
            ).rejects.toThrow("different account");
            await runtime.close();
        } finally {
            AiConfigStore.invalidate();
        }
    });
});

test("the daemon refuses stale thread/home guards before RPC even when the worker name still matches", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-guard-"));
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
        const store = new CodexSessionStore();
        const meta = makeMeta(home);
        store.writeMeta(meta);
        const client = new FakeRpcClient();
        const runtime = new CodexSessionRuntime({ client, store, meta });
        await runtime.start({});
        client.requests.length = 0;
        client.rejectNextTurn = new Error("Native turn/start must not be called for a stale identity");

        for (const expectedTarget of [
            { threadId: "replacement", home },
            { threadId: "thread-1", home: join(home, "other") },
        ]) {
            await expect(
                runtime.execute({ op: "steer", body: "guarded", force: true, expectedTarget })
            ).rejects.toThrow("no prompt was sent");
            expect(client.requests).toEqual([]);
        }

        client.rejectNextTurn = null;
        expect(
            await runtime.execute({
                op: "steer",
                body: "normal",
                force: false,
                expectedTarget: { threadId: "thread-1", home },
            })
        ).toMatchObject({ turnId: "turn-1", queued: false });
        expect(client.requests.map((request) => request.method)).toEqual(["turn/start"]);
    });
});

test("--project is resolved before the thread starts, and the thread is filed once its first message is recorded", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-project-"));

    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
        const store = new CodexSessionStore();
        const meta = makeMeta(home);
        store.writeMeta(meta);
        const client = new FakeRpcClient();
        client.threads = [{ id: "thread-1", projectId: null }];
        const runtime = new CodexSessionRuntime({ client, store, meta, project: "tools" });
        const methods = () => client.requests.map((request) => request.method);

        await runtime.start({ prompt: "Begin" });
        expect(methods()).toEqual(["initialize", "project/list", "thread/start", "turn/start"]);
        expect(client.requests[0]?.params).toMatchObject({ capabilities: { experimentalApi: true } });

        // A thread is not in thread/list before its first user message is recorded.
        await runtime.handleNotification({ method: "turn/started", params: { turn: { id: "turn-1" } } });
        expect(methods()).not.toContain("thread/list");

        await runtime.handleNotification({
            method: "item/completed",
            params: { item: { type: "userMessage", id: "u1" } },
        });
        await runtime.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-1" } } });

        expect(client.requests.filter((request) => request.method === "thread/metadata/update")).toEqual([
            { method: "thread/metadata/update", params: { threadId: "thread-1", projectId: "p-tools" } },
        ]);
        expect((await store.readMeta("reviewer"))?.desktopProject).toEqual({ id: "p-tools", name: "Tools" });
    });
});

test("an unknown --project fails the start before any thread exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-project-miss-"));

    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
        const store = new CodexSessionStore();
        const meta = makeMeta(home);
        store.writeMeta(meta);
        const client = new FakeRpcClient();
        const runtime = new CodexSessionRuntime({ client, store, meta, project: "nope" });

        await expect(runtime.start({ prompt: "Begin" })).rejects.toThrow('No Codex Desktop project matches "nope"');
        expect(client.requests.map((request) => request.method)).toEqual(["initialize", "project/list"]);
    });
});

test("a native subagent's turns and usage never become the worker's own", async () => {
    // A subagent's thread shares the worker's app-server. Counting its events moved activeTurnId to the
    // subagent's turn and would have reported the worker ready when only the subagent finished.
    const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-subagent-"));

    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
        const store = new CodexSessionStore();
        const meta = makeMeta(home);
        store.writeMeta(meta);
        const runtime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta });
        await runtime.start({ prompt: "Begin" });

        const subagent = { method: "turn/started", params: { threadId: "sub-1", turn: { id: "sub-turn" } } };
        expect(runtime.isOwnThreadEvent(subagent)).toBe(false);
        await runtime.handleNotification(subagent);
        await runtime.handleNotification({
            method: "thread/tokenUsage/updated",
            params: { threadId: "sub-1", tokenUsage: { total: { inputTokens: 999 } } },
        });
        await runtime.handleNotification({
            method: "turn/completed",
            params: { threadId: "sub-1", turn: { id: "sub-turn" } },
        });

        const during = await store.readMeta("reviewer");
        expect(during?.status).toBe("running");
        expect(during?.activeTurnId).toBe("turn-1");
        expect(during?.usage).toBeUndefined();

        await runtime.handleNotification({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1" } },
        });
        expect((await store.readMeta("reviewer"))?.status).toBe("ready");
        expect((await store.readEvents("reviewer")).filter((event) => event.method === "turn/completed")).toHaveLength(
            2
        );
    });
});

describe("an ask worker's own bus commands", () => {
    const own = (args: string) => `/bin/zsh -lc "tools agents ${args} --session parent-123"`;

    test("the seeded verbs, run as the worker in its swarm, are its own", () => {
        const bus = { agentName: "codex_reviewer", session: "parent-123" };

        expect(isOwnBusCommand(own("message --from codex_reviewer --to lead --body 'received; starting'"), bus)).toBe(
            true
        );
        expect(isOwnBusCommand(own("login --agent-name codex_reviewer --once"), bus)).toBe(true);
        expect(isOwnBusCommand(own("message --from codex_reviewer --reply 0007 --body='done, see x=1'"), bus)).toBe(
            true
        );
        expect(
            isOwnBusCommand(
                "tools agents request --from codex_reviewer --to lead --body plan --session parent-123",
                bus
            )
        ).toBe(true);
    });

    test("anything chained, expanded, redirected, another identity or another swarm is not", () => {
        const bus = { agentName: "codex_reviewer", session: "parent-123" };

        for (const command of [
            own("message --from codex_reviewer --to lead --body x; touch /tmp/pwned"),
            own("message --from codex_reviewer --to lead --body x && echo hi"),
            own("message --from codex_reviewer --to lead --body x > /tmp/out"),
            `/bin/zsh -lc "tools agents message --from codex_reviewer --to lead --body \\"$(id)\\" --session parent-123"`,
            own("message --from codex_reviewer --to lead --body `id`"),
            own("message --from lead --to codex_reviewer --body x"),
            own("login --agent-name codex_reviewer --once --observer"),
            own("message --from codex_reviewer --to lead --body x --session other"),
            "tools agents message --from codex_reviewer --to lead --body x",
            "tools hub message --from codex_reviewer --session parent-123",
            own("message --from codex_reviewer --to lead --body x\nrm -rf ~"),
        ]) {
            expect({ command, own: isOwnBusCommand(command, bus) }).toEqual({ command, own: false });
        }
    });

    test("the runtime accepts them itself and still forwards everything else to the lead", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-bus-approval-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = { ...makeMeta(home), writePolicy: "ask" as const, approvalPolicy: "untrusted" as const };
            store.writeMeta(meta);
            const notices: unknown[] = [];
            const runtime = new CodexSessionRuntime({
                client: new FakeRpcClient(),
                store,
                meta,
                onApprovalRequest: (notice) => {
                    notices.push(notice);
                },
            });
            await runtime.start({});
            const method = "item/commandExecution/requestApproval";

            await expect(
                runtime.handleServerRequest({
                    id: 1,
                    method,
                    params: { threadId: "thread-1", command: own("message --from codex_reviewer --to lead --body hi") },
                })
            ).resolves.toEqual({ decision: "accept" });
            expect(notices).toEqual([]);

            // A subagent's copy of the same command is not the worker's: tools agents refuses it anyway.
            const fromSubagent = runtime.handleServerRequest({
                id: 2,
                method,
                params: { threadId: "sub-1", command: own("message --from codex_reviewer --to lead --body hi") },
            });
            const other = runtime.handleServerRequest({
                id: 3,
                method,
                params: { threadId: "thread-1", command: "touch x" },
            });
            await Bun.sleep(0);
            expect(notices).toHaveLength(2);

            await runtime.execute({ op: "deny", requestId: "2" });
            await runtime.execute({ op: "deny", requestId: "3" });
            await expect(fromSubagent).resolves.toEqual({ decision: "decline" });
            await expect(other).resolves.toEqual({ decision: "decline" });
        });
    });
});
