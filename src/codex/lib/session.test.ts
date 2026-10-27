import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerCostRows } from "@app/ai-spend/lib/workers/ledger";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { CONFIG_VERSION } from "@genesiscz/utils/ai/config/schema";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ThreadTurnsListParams, Turn } from "./_generated/protocol";
import { CodexAccountBinding } from "./account";
import { isOwnBusCommand, isReadOnlyCommand } from "./bus-approval";
import { readReviewRecords } from "./review/ledger";
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

    test("books each finished turn in the cost ledger from per-call usage, and hands the bus its cost line", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-cost-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = { ...makeMeta(home), label: "review-loop pr1", effort: "medium" };
            store.writeMeta(meta);
            const runtime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta });
            await runtime.start({});
            const call = (input: number, cached: number, output: number) => ({
                method: "thread/tokenUsage/updated",
                params: {
                    threadId: "thread-1",
                    tokenUsage: {
                        last: {
                            inputTokens: input,
                            cachedInputTokens: cached,
                            outputTokens: output,
                            reasoningOutputTokens: 1,
                        },
                    },
                },
            });

            await runtime.handleNotification({ method: "account/updated", params: { authMode: "chatgpt" } });
            await runtime.handleNotification({
                method: "thread/started",
                params: { thread: { id: "thread-1", model: "gpt-6.1-sol" } },
            });
            await runtime.handleNotification({
                method: "turn/started",
                params: { threadId: "thread-1", turn: { id: "turn-1" } },
            });
            await runtime.handleNotification({
                method: "thread/started",
                params: { thread: { id: "sub-1", model: "gpt-6-astra" } },
            });
            await runtime.handleNotification(call(100_000, 60_000, 2_000));
            await runtime.handleNotification(call(150_000, 140_000, 3_000));
            await runtime.handleNotification({
                method: "item/completed",
                params: { threadId: "thread-1", item: { type: "commandExecution", id: "i1" } },
            });
            await runtime.handleNotification({
                method: "item/completed",
                params: { threadId: "thread-1", item: { type: "agentMessage", id: "i2" } },
            });
            // Another thread in the same app-server is a native subagent's: never this worker's cost.
            await runtime.handleNotification({
                ...call(900_000, 0, 9_000),
                params: { ...call(900_000, 0, 9_000).params, threadId: "sub" },
            });
            const done = {
                method: "turn/completed",
                params: { threadId: "thread-1", turn: { id: "turn-1", durationMs: 42_000 } },
            };
            await runtime.handleNotification(done);

            const rows = readWorkerCostRows().filter((row) => row.name === "reviewer");
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                backend: "codex",
                sessionId: "thread-1",
                turn: 1,
                model: "gpt-6.1-sol",
                effort: "medium",
                auth: "subscription",
                durationMs: 42_000,
                toolCalls: 1,
                label: "review-loop pr1",
                outcome: "completed",
                tokens: { input: 50_000, cacheRead: 200_000, cacheWrite: 0, output: 5_000, reasoning: 2 },
            });
            // gpt-6.1-sol per call: 40K x $2 + 60K x $0.10 + 2K x $10, then 10K x $2 + 140K x $0.10 + 3K x $10.
            expect(rows[0]?.cost.apiEquivalentUsd).toBeCloseTo(0.106 + 0.064, 10);
            expect(rows[0]?.cost.billedUsd).toBe(0);
            expect(runtime.turnCostEnvelope(done)).toEqual({
                cost: expect.stringMatching(
                    /^cost: \$0\.17 API-equivalent \(subscription, billed \$0\) · as Claude ≈ Opus/
                ),
            });
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

            const fullMeta = {
                ...makeMeta(home),
                name: "full",
                writePolicy: "full" as const,
                sandbox: "danger-full-access" as const,
            };
            store.writeMeta(fullMeta);
            const fullRuntime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta: fullMeta });
            // Raced against a deadline: a request that fell through to the ask path waits for an approve control
            // that never comes, and that must fail here instead of hanging the file.
            const fullAnswer = await Promise.race([
                fullRuntime.handleServerRequest({
                    id: "full-1",
                    method: "item/commandExecution/requestApproval",
                    params: { command: "git commit -m x" },
                }),
                Bun.sleep(1_000).then(() => "still pending after 1 s"),
            ]);
            expect(fullAnswer).toEqual({ decision: "accept" });
            expect(store.readMeta("full")?.pendingApprovals).toEqual({});
            await fullRuntime.close();
        });
    });

    test("all four approval methods wait for explicit approve or deny controls", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-manual-controls-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = { ...makeMeta(home), writePolicy: "ask" as const, approvalPolicy: "untrusted" as const };
            store.writeMeta(meta);
            const runtime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta });
            const methods = [
                {
                    method: "item/commandExecution/requestApproval",
                    params: { command: "cat README.md", cwd: home },
                    legacy: false,
                },
                { method: "item/fileChange/requestApproval", params: { itemId: "file-1" }, legacy: false },
                { method: "execCommandApproval", params: { command: ["cat", "README.md"], cwd: home }, legacy: true },
                { method: "applyPatchApproval", params: { fileChanges: {} }, legacy: true },
            ];
            for (const { method, params, legacy } of methods) {
                for (const op of ["approve", "deny"] as const) {
                    const id = `${method}-${op}`;
                    let settled = false;
                    const pending = runtime.handleServerRequest({ id, method, params });
                    void pending.then(() => {
                        settled = true;
                    });
                    await Bun.sleep(0);
                    expect(settled).toBe(false);
                    expect(store.readMeta(meta.name)?.pendingApprovals[id]).toBeDefined();
                    await runtime.execute({ op, requestId: id });
                    const decision =
                        op === "approve" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline";
                    await expect(pending).resolves.toEqual({ decision });
                    expect(store.readMeta(meta.name)?.pendingApprovals[id]).toBeUndefined();
                }
            }
            await runtime.close();
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

    test("pending commands preserve executable text and cwd independently of the reason", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-approval-command-"));
        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = { ...makeMeta(home), writePolicy: "ask" as const, approvalPolicy: "untrusted" as const };
            store.writeMeta(meta);
            const runtime = new CodexSessionRuntime({ client: new FakeRpcClient(), store, meta });
            const pending = runtime.handleServerRequest({
                id: "command-context",
                method: "item/commandExecution/requestApproval",
                params: { reason: "bunx biome check src/a.ts", command: "touch outside.ts", cwd: home },
            });
            await Bun.sleep(0);
            try {
                expect(store.readMeta(meta.name)?.pendingApprovals["command-context"]).toMatchObject({
                    detail: "bunx biome check src/a.ts",
                    command: "touch outside.ts",
                    cwd: home,
                });
            } finally {
                await runtime.execute({ op: "deny", requestId: "command-context" });
                await expect(pending).resolves.toEqual({ decision: "decline" });
            }
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

    test("only absolute system shells may wrap an automatically approved script", () => {
        const bus = { agentName: "codex_reviewer", session: "parent-123" };
        const script = "tools agents login --agent-name codex_reviewer --once --session parent-123";
        for (const shell of ["/tmp/bash", "./zsh", "/repo/sh", "bash", "zsh", "sh"]) {
            expect(isOwnBusCommand(shell + " -lc '" + script + "'", bus)).toBe(false);
            expect(isReadOnlyCommand(shell + " -lc 'cat README.md'")).toBe(false);
        }
        for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
            expect(isOwnBusCommand(shell + " -lc '" + script + "'", bus)).toBe(true);
            expect(isReadOnlyCommand(shell + " -lc 'cat README.md'")).toBe(true);
        }
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

    test("the runtime holds its own bus command for an explicit lead decision", async () => {
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

            const ownRequest = runtime.handleServerRequest({
                id: 1,
                method,
                params: { threadId: "thread-1", command: own("message --from codex_reviewer --to lead --body hi") },
            });

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
            expect(notices).toHaveLength(3);
            await runtime.execute({ op: "approve", requestId: "1" });
            await expect(ownRequest).resolves.toEqual({ decision: "accept" });

            await runtime.execute({ op: "deny", requestId: "2" });
            await runtime.execute({ op: "deny", requestId: "3" });
            await expect(fromSubagent).resolves.toEqual({ decision: "decline" });
            await expect(other).resolves.toEqual({ decision: "decline" });
        });
    });
});
describe("an ask worker's read-only commands", () => {
    const zsh = (script: string) => `/bin/zsh -lc '${script}'`;

    test.each(["constructor", "toString", "toLocaleString", "__proto__", "valueOf", "hasOwnProperty"])(
        "an inherited allowlist name must require approval: %s",
        (name) => {
            for (const command of [
                name,
                `${name} payload`,
                zsh(`${name} payload`),
                `cat README.md && ${name} payload`,
            ]) {
                expect(isReadOnlyCommand(command)).toBe(false);
            }
        }
    );

    test("reads, searches and read-only git need no approval, as Codex's own safe set intends", () => {
        for (const command of [
            zsh("cat CLAUDE.md"),
            zsh("sed -n '\"'\"'140,410p'\"'\"' src/a.ts"),
            zsh("nl -ba src/a.ts | head -430\nnl -ba README.md | head -75"),
            `/bin/zsh -lc "rg -n 'background|openBackground' src/a.test.ts | head -40"`,
            zsh(
                "git diff --no-ext-diff --no-textconv --stat\ngit diff --no-ext-diff --no-textconv --cached --name-only\ngit branch --show-current"
            ),
            zsh("git show --no-ext-diff --no-textconv origin/feature:src/a.ts | sed -n 315,380p"),
            zsh("cd src && ls -la && wc -l a.ts"),
            zsh("find src -name '\"'\"'*.ts'\"'\"' -newer a.ts"),
            // Backslashes in a double-quoted wrapper and discarded streams remain read-only.
            `/bin/zsh -lc "rg -n 'parse\\\\(' src/utils/json.ts | head -15"`,

            zsh("ls missing 2>/dev/null\ngit log --no-ext-diff --no-textconv --oneline -5 2>&1 | head"),
            zsh("cat ~/notes.md src/\\(a\\).ts"),
        ]) {
            expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: true });
        }
    });

    test("a write, a program run, a redirection, an expansion or a background job still asks the lead", () => {
        for (const command of [
            zsh("cat a.ts > b.ts"),
            zsh("sed -i '\"'\"''\"'\"' s/a/b/ a.ts"),
            zsh("sed -n '\"'\"'w out'\"'\"' a.ts"),
            zsh("sed -n 1,5p -i a.ts"),
            zsh("rg --pre ./run.sh x src"),
            `/bin/zsh -lc "rg -n 'WebSocket|Bun.serve' src/utils/chrome-devtools/*.test.ts | head -40"`,
            zsh("git -c core.pager=./run.sh log"),
            zsh("git diff --output=patch.diff"),
            zsh("git grep --open-files-in-pager=./run.sh pattern"),
            zsh("git grep --no-textconv -O./run.sh pattern"),
            zsh("git diff --ext-diff"),
            zsh("git show --textconv"),
            zsh("git show HEAD"),
            zsh("git cat-file --filters HEAD:src/a.ts"),
            zsh("git log --no-ext-diff --no-textconv --exec=./run.sh"),
            zsh("git branch new-branch"),
            zsh("git commit -m x"),
            zsh("find . -name x -delete"),
            zsh("find . -exec rm {} ;"),
            zsh("cat a.ts\nrm -rf src"),
            zsh("cat a.ts & touch x"),
            `/bin/zsh -lc "cat $(echo a.ts)"`,
            zsh("cat `echo a.ts`"),
            zsh("bun scripts/test.ts"),
            zsh("FOO=1 cat a.ts"),
            zsh("cat 'unclosed"),
            zsh("cat a.ts 2>err.log"),
            zsh("cat a.ts >> out.ts"),
            zsh("cat a.ts >/dev/nullx"),
            zsh("cat <(echo a.ts)"),
            zsh("cat a.ts 2>/dev/null; rm b.ts"),
            `/bin/zsh -lc "cat \\"$HOME/a.ts\\""`,
            zsh("cat a.ts &"),
            "",
        ]) {
            expect({ command, readOnly: isReadOnlyCommand(command) }).toEqual({ command, readOnly: false });
        }
    });

    test.each([
        "find . -ex\\\nec /bin/sh -c 'touch /tmp/approval-bypass' ';'",
        'find . "-ex\\\nec" /bin/sh -c "touch /tmp/approval-bypass" ";"',
        "rg --p\\\nre=./runner needle .",
        'rg "--p\\\nre=./runner" needle .',
        "find . -ex\\\r\nec /bin/sh -c 'touch /tmp/approval-bypass' ';'",
        "rg --p\\\r\nre=./runner needle .",
    ])("shell line continuations cannot conceal dangerous options: %s", (script) => {
        expect(isReadOnlyCommand(script)).toBe(false);
        const quoted = "'" + script.replaceAll("'", "'\"'\"'") + "'";
        expect(isReadOnlyCommand(`/bin/sh -c ${quoted}`)).toBe(false);
        expect(isReadOnlyCommand(`/bin/zsh -lc ${quoted}`)).toBe(false);
    });

    test("ordinary escapes and quoted newlines still qualify as read-only", () => {
        expect(isReadOnlyCommand("cat with\\ space.ts")).toBe(true);
        expect(isReadOnlyCommand("cat 'first\nsecond'")).toBe(true);
        expect(isReadOnlyCommand('rg "needle" README.md')).toBe(true);
    });

    test("unquoted globs cannot introduce executable options from filenames", () => {
        const cwd = mkdtempSync(join(tmpdir(), "gt-approval-glob-"));
        writeFileSync(join(cwd, "--pre=sh"), "");
        writeFileSync(join(cwd, "payload"), "fixture data only");
        const expansion = Bun.spawnSync(["/bin/sh", "-c", "printf '%s\\n' *"], { cwd, env: env.getProcessEnv() });
        expect(expansion.exitCode).toBe(0);
        expect(expansion.stdout.toString()).toContain("--pre=sh");
        for (const command of ["rg needle *", "rg needle ?", "rg needle [a-z]*", zsh("rg needle *")]) {
            expect(isReadOnlyCommand(command)).toBe(false);
        }
        expect(isReadOnlyCommand("rg -g '*.ts' needle src")).toBe(true);
        expect(isReadOnlyCommand("cat literal\\*name")).toBe(true);
    });

    test("shell comments cannot hide a write behind unmatched quotes", () => {
        expect(isReadOnlyCommand("cat README.md # '\ntouch /tmp/approval-bypass\n# '")).toBe(false);
        expect(isReadOnlyCommand('cat README.md # "\ntouch /tmp/approval-bypass\n# "')).toBe(false);
        expect(isReadOnlyCommand("cat 'a#b.ts'")).toBe(true);
        expect(isReadOnlyCommand("cat a\\#b.ts")).toBe(true);
    });

    test("the runtime holds a read-only command and names file changes for the lead", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-read-only-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta = { ...makeMeta(home), writePolicy: "ask" as const, approvalPolicy: "untrusted" as const };
            store.writeMeta(meta);
            const notices: Array<{ detail?: string }> = [];
            const runtime = new CodexSessionRuntime({
                client: new FakeRpcClient(),
                store,
                meta,
                onApprovalRequest: (notice) => {
                    notices.push(notice);
                },
            });
            await runtime.start({});

            const read = runtime.handleServerRequest({
                id: 1,
                method: "item/commandExecution/requestApproval",
                params: { threadId: "thread-1", command: zsh("cat CLAUDE.md") },
            });
            await Bun.sleep(0);
            expect(notices).toHaveLength(1);
            await runtime.execute({ op: "deny", requestId: "1" });
            await expect(read).resolves.toEqual({ decision: "decline" });
            notices.length = 0;

            await runtime.handleNotification({
                method: "item/started",
                params: {
                    threadId: "thread-1",
                    item: {
                        type: "fileChange",
                        id: "exec-1",
                        changes: [
                            { path: join(meta.cwd, "src", "a.ts (copy).ts") },
                            { path: join(meta.cwd, "src", "a,b.ts") },
                        ],
                    },
                },
            });
            const edit = runtime.handleServerRequest({
                id: 2,
                method: "item/fileChange/requestApproval",
                params: { threadId: "thread-1", itemId: "exec-1" },
            });
            await Bun.sleep(0);

            expect(notices.map((notice) => notice.detail)).toEqual([
                `edit ${join("src", "a.ts (copy).ts")}, ${join("src", "a,b.ts")}`,
            ]);
            expect(store.readMeta(meta.name)?.pendingApprovals["2"].paths).toEqual([
                join("src", "a.ts (copy).ts"),
                join("src", "a,b.ts"),
            ]);
            await runtime.execute({ op: "approve", requestId: "2" });
            await expect(edit).resolves.toEqual({ decision: "accept" });
        });
    });
});

describe("a --mode review session", () => {
    const report = (reviewed: number) =>
        `Findings: none\nRan: nothing\nFiles reviewed: ${reviewed} of 2\nNot reviewed: none`;

    async function finishTurn(runtime: CodexSessionRuntime, turn: string, text: string, reasoning = 5): Promise<void> {
        const params = { threadId: "thread-1" };
        await runtime.handleNotification({ method: "turn/started", params: { ...params, turn: { id: turn } } });
        await runtime.handleNotification({
            method: "thread/tokenUsage/updated",
            params: {
                ...params,
                tokenUsage: { last: { inputTokens: 100, outputTokens: 50, reasoningOutputTokens: reasoning } },
            },
        });
        await runtime.handleNotification({
            method: "item/completed",
            params: { ...params, item: { type: "agentMessage", id: `${turn}-msg`, text } },
        });
        await runtime.handleNotification({
            method: "turn/completed",
            params: { ...params, turn: { id: turn, status: "completed" } },
        });
    }

    test("gets its tier and manifest, steers once on a miss, escalates on the second, and ends shallow when that fails", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-codex-runtime-review-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const store = new CodexSessionStore();
            const meta: CodexSessionMeta = {
                ...makeMeta(home),
                name: "rv",
                agentsEnabled: false,
                writePolicy: "deny",
                sandbox: "read-only",
                effort: "high",
                review: {
                    base: "origin/master",
                    baseSource: "flag",
                    baseDetail: "--base",
                    pr: 12,
                    manifest: {
                        base: "origin/master",
                        files: [
                            { path: "src/a.ts", added: 40, deleted: 2 },
                            { path: "src/b.ts", added: 8, deleted: 0 },
                        ],
                        added: 48,
                        deleted: 2,
                    },
                    effort: "high",
                    effortSource: "diff-size",
                    allowShallow: false,
                    step: 0,
                    chain: "rv",
                },
            };
            store.writeMeta(meta);
            const client = new FakeRpcClient();
            const escalations: string[] = [];
            const gateEvents: unknown[] = [];
            const runtime = new CodexSessionRuntime({
                client,
                store,
                meta,
                escalateReview: async (request) => {
                    escalations.push(`${request.name} at ${request.effort}`);
                    throw new Error('Codex session "rv-xhigh" is already active');
                },
                onReviewGate: (event) => {
                    gateEvents.push(event.verdict);
                },
            });

            await runtime.start({ prompt: "Review PR 12." });
            const threadStart = client.requests.find((request) => request.method === "thread/start");
            const startParams = threadStart?.params as { developerInstructions?: string } | undefined;
            const instructions = String(startParams?.developerInstructions);
            expect(instructions).toContain("You are a code REVIEWER at the high tier.");
            expect(instructions).toContain("Files to review (2, +48 -2):\n- src/a.ts +40 -2\n- src/b.ts +8 -0");
            expect((await store.readMeta("rv"))?.review?.prompt).toBe("Review PR 12.");

            await finishTurn(runtime, "turn-1", report(1));
            const steers = client.requests.filter((request) => request.method === "turn/start");
            expect(steers).toHaveLength(2);
            const steerText = (steers[1].params as { input: Array<{ text: string }> }).input[0].text;
            expect(steerText).toContain("You did not read: src/a.ts, src/b.ts.");
            // The session never reads as idle between the missed turn and its steer.
            expect((await store.readMeta("rv"))?.status).toBe("running");
            expect((await store.readMeta("rv"))?.review).toMatchObject({ verdict: "steered", step: 1 });

            await finishTurn(runtime, "turn-2", report(1));
            expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
            expect(escalations).toEqual(["rv-xhigh at xhigh"]);

            const after = await store.readMeta("rv");
            expect(after?.status).toBe("ready");
            expect(after?.review?.verdict).toBe("shallow");
            expect(after?.review?.reason).toContain('the escalate failed: Codex session "rv-xhigh" is already active');
            expect(after?.review?.spent).toMatchObject({ turns: 2, reasoningTokens: 10 });
            expect(gateEvents).toEqual(["steered", "escalated", "shallow"]);
            expect(
                readReviewRecords().records.map(
                    (record) => `${record.kind}:${"verdict" in record ? record.verdict : ""}`
                )
            ).toEqual(["turn:", "gate:steered", "turn:", "gate:escalated", "gate:shallow"]);

            // A passing review needs no step: a full report with enough reasoning ends the gate at once.
            const passing = new CodexSessionRuntime({
                client: new FakeRpcClient(),
                store,
                meta: { ...meta, name: "rv-ok", review: { ...meta.review!, chain: "rv-ok", prompt: "x" } },
            });
            store.writeMeta({ ...meta, name: "rv-ok" });
            await passing.start({});
            await finishTurn(passing, "turn-1", report(2), 500);
            expect((await store.readMeta("rv-ok"))?.review).toMatchObject({ verdict: "pass", step: 0 });
            expect((await store.readMeta("rv-ok"))?.status).toBe("ready");
        });
    });
});
