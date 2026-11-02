import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { AppServerClient, type AppServerProcess, AppServerRpcError, appServerCommand } from "./app-server-client";

function createProcessHarness(): {
    process: AppServerProcess;
    writes: string[];
    push: (message: Record<string, unknown>) => void;
} {
    const writes: string[] = [];
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
            stdoutController = controller;
        },
    });

    // A real app-server dies on SIGTERM. A fake one that never exits makes close() wait out
    // both 2 s reap grace periods on every test, 24 s for this file.
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        exit = resolve;
    });

    return {
        process: {
            pid: 42,
            stdin: {
                write(value: string | Uint8Array) {
                    writes.push(typeof value === "string" ? value : new TextDecoder().decode(value));
                    return value.length;
                },
                end() {
                    return undefined;
                },
            },
            stdout,
            stderr: new ReadableStream<Uint8Array>({ start() {} }),
            exited,
            kill() {
                exit(0);
            },
        },
        writes,
        push(message) {
            stdoutController?.enqueue(encoder.encode(`${SafeJSON.stringify(message, { strict: true })}\n`));
        },
    };
}

describe("AppServerClient", () => {
    test("an error response keeps the server's code and data, so a caller can read codexErrorInfo", async () => {
        const harness = createProcessHarness();
        const client = new AppServerClient(harness.process, {});
        const pending = client.request("turn/steer");

        await Bun.sleep(0);
        const request = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as { id: number };
        const data = { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } };
        harness.push({ id: request.id, error: { code: -32600, message: "cannot steer a review turn", data } });

        const error = await pending.catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AppServerRpcError);
        expect(error).toMatchObject({ message: "cannot steer a review turn", code: -32600, data });
        await client.close();
    });

    // The reader used to await the handler, so a handler that never settled held every
    // later response line and a handler that threw tore the loop down.
    test("a hanging notification handler does not delay a later response", async () => {
        const harness = createProcessHarness();
        const client = new AppServerClient(harness.process, {
            onNotification: () => new Promise<void>(() => {}),
        });
        const resultPromise = client.request<{ ok: boolean }>("thread/read");

        await Bun.sleep(0);
        const request = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as { id: number };

        harness.push({ method: "turn/started", params: {} });
        harness.push({ id: request.id, result: { ok: true } });

        await expect(resultPromise).resolves.toEqual({ ok: true });
        await client.close();
    });

    test("a rejecting notification handler does not reject pending requests", async () => {
        const harness = createProcessHarness();
        const seen: string[] = [];
        const client = new AppServerClient(harness.process, {
            onNotification: async (notification) => {
                seen.push(notification.method);
                throw new Error("handler exploded");
            },
        });
        const resultPromise = client.request<{ ok: boolean }>("thread/read");

        await Bun.sleep(0);
        const request = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as { id: number };

        harness.push({ method: "turn/started", params: {} });
        await Bun.sleep(10);
        harness.push({ id: request.id, result: { ok: true } });

        await expect(resultPromise).resolves.toEqual({ ok: true });
        expect(seen).toEqual(["turn/started"]);
        await client.close();
    });

    // Ordering survives the detachment: the queue is a chain, not a fan-out.
    test("notifications reach the handler in arrival order", async () => {
        const harness = createProcessHarness();
        const seen: string[] = [];
        let finish!: () => void;
        const completed = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const client = new AppServerClient(harness.process, {
            onNotification: async (notification) => {
                await Bun.sleep(notification.method === "first" ? 5 : 0);
                seen.push(notification.method);
                if (notification.method === "second") {
                    finish();
                }
            },
        });

        harness.push({ method: "first", params: {} });
        harness.push({ method: "second", params: {} });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                completed,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("Notification callbacks did not finish")), 2000);
                }),
            ]);
            expect(seen).toEqual(["first", "second"]);
        } finally {
            clearTimeout(timer);
            await client.close();
        }
    });

    test("approval waits for preceding file changes while a filing RPC response bypasses the queue", async () => {
        const harness = createProcessHarness();
        const seen: string[] = [];
        const approval = Promise.withResolvers<void>();
        const filing = Promise.withResolvers<void>();
        let client: AppServerClient;
        client = new AppServerClient(harness.process, {
            onNotification: async (notification) => {
                if (notification.method === "item/userMessage") {
                    const pending = client.request("thread/read");
                    filing.resolve();
                    await pending;
                }
                seen.push(notification.method);
            },
            onServerRequest: () => {
                expect(seen).toEqual(["item/userMessage", "item/started"]);
                approval.resolve();
                return { decision: "accept" };
            },
        });
        try {
            harness.push({ method: "item/userMessage" });
            await filing.promise;
            harness.push({
                method: "item/started",
                params: { item: { type: "fileChange", id: "edit-1", changes: [{ path: "/w/a.ts" }] } },
            });
            harness.push({ id: "approval-1", method: "item/fileChange/requestApproval", params: { itemId: "edit-1" } });
            const request = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as { id: number };
            harness.push({ id: request.id, result: {} });
            await approval.promise;
        } finally {
            await client.close();
        }
    });

    test("correlates request responses by id", async () => {
        const harness = createProcessHarness();
        const client = new AppServerClient(harness.process);
        const resultPromise = client.request<{ thread: { id: string } }>("thread/read", { threadId: "thread-1" });

        await Bun.sleep(0);
        const request = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as {
            id: number;
            method: string;
        };
        expect(request.method).toBe("thread/read");

        harness.push({ id: request.id, result: { thread: { id: "thread-1" } } });

        await expect(resultPromise).resolves.toEqual({ thread: { id: "thread-1" } });
        await client.close();
    });

    test("dispatches notifications and server requests", async () => {
        const harness = createProcessHarness();
        const notifications: string[] = [];
        const client = new AppServerClient(harness.process, {
            onNotification: (notification) => {
                notifications.push(notification.method);
            },
            onServerRequest: async (request) => ({
                decision: request.method.includes("fileChange") ? "accept" : "decline",
            }),
        });

        harness.push({ method: "turn/started", params: { turn: { id: "turn-1" } } });
        harness.push({ id: "approval-1", method: "item/fileChange/requestApproval", params: { itemId: "item-1" } });
        await Bun.sleep(10);

        expect(notifications).toEqual(["turn/started"]);
        const response = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as {
            id: string;
            result: { decision: string };
        };
        expect(response).toEqual({ id: "approval-1", result: { decision: "accept" } });
        await client.close();
    });

    test("continues reading responses while a server approval is pending", async () => {
        const harness = createProcessHarness();
        let resolveApproval: (decision: { decision: string }) => void = () => {};
        const approval = new Promise<{ decision: string }>((resolve) => {
            resolveApproval = resolve;
        });
        const client = new AppServerClient(harness.process, {
            onServerRequest: () => approval,
        });

        harness.push({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
        await Bun.sleep(0);
        const read = client.request<{ thread: { id: string } }>("thread/read", { threadId: "thread-1" });
        const request = SafeJSON.parse(harness.writes[0] ?? "", { strict: true }) as { id: number };
        harness.push({ id: request.id, result: { thread: { id: "thread-1" } } });

        await expect(
            Promise.race([
                read,
                Bun.sleep(30).then(() => {
                    throw new Error("response reader blocked behind approval");
                }),
            ])
        ).resolves.toEqual({ thread: { id: "thread-1" } });

        resolveApproval({ decision: "accept" });
        await Bun.sleep(0);
        expect(harness.writes).toHaveLength(2);
        await client.close();
    });

    test("answered settles once the answer to a server request is written, so a caller can send after it", async () => {
        const harness = createProcessHarness();
        let resolveApproval: (decision: { decision: string }) => void = () => {};
        const approval = new Promise<{ decision: string }>((resolve) => {
            resolveApproval = resolve;
        });
        const client = new AppServerClient(harness.process, { onServerRequest: () => approval });

        harness.push({ id: "approval-2", method: "item/fileChange/requestApproval", params: {} });
        await Bun.sleep(0);
        let settled = false;
        const answered = client.answered("approval-2").then(() => {
            settled = true;
        });
        await Bun.sleep(0);

        expect(settled).toBe(false);

        resolveApproval({ decision: "decline" });
        await answered;

        expect(harness.writes.map((line) => SafeJSON.parse(line, { strict: true }))).toEqual([
            { id: "approval-2", result: { decision: "decline" } },
        ]);
        await expect(client.answered("never-asked")).resolves.toBeUndefined();
        await client.close();
    });

    test("answered waits for an answer write that completes later, not only for the handler", async () => {
        const harness = createProcessHarness();
        let finishWrite: () => void = () => {};
        const realWrite = harness.process.stdin.write;
        harness.process.stdin.write = (value) => {
            realWrite(value);
            return new Promise<number>((resolve) => {
                finishWrite = () => resolve(value.length);
            });
        };
        const client = new AppServerClient(harness.process, { onServerRequest: () => ({ decision: "decline" }) });
        let settled = false;

        harness.push({ id: "approval-3", method: "item/fileChange/requestApproval", params: {} });
        await Bun.sleep(0);
        const answered = client.answered("approval-3").then(() => {
            settled = true;
        });
        await Bun.sleep(5);

        // The handler answered and the line is handed to stdin, but the write has not completed.
        expect(harness.writes).toHaveLength(1);
        expect(settled).toBe(false);

        finishWrite();
        await answered;

        expect(settled).toBe(true);
        await client.close();
    });

    test("answered rejects when the answer write fails, and the failed write is not answered as a handler error", async () => {
        const harness = createProcessHarness();
        const realWrite = harness.process.stdin.write;
        let failNext = true;
        harness.process.stdin.write = (value) => {
            realWrite(value);

            if (failNext) {
                failNext = false;
                return Promise.reject(new Error("stdin closed"));
            }

            return value.length;
        };
        let resolveApproval: (decision: { decision: string }) => void = () => {};
        const approval = new Promise<{ decision: string }>((resolve) => {
            resolveApproval = resolve;
        });
        const client = new AppServerClient(harness.process, { onServerRequest: () => approval });

        harness.push({ id: "approval-4", method: "item/fileChange/requestApproval", params: {} });
        await Bun.sleep(0);
        // As `resolveApproval` in the codex session asks: right after it resolved the decision.
        const answered = client.answered("approval-4");
        resolveApproval({ decision: "decline" });

        await expect(answered).rejects.toThrow("stdin closed");
        // Only the decline was tried: no error response went out in its place.
        expect(harness.writes.map((line) => SafeJSON.parse(line, { strict: true }))).toEqual([
            { id: "approval-4", result: { decision: "decline" } },
        ]);
        await client.close();
    });

    test("rejects pending requests when the child exits", async () => {
        let resolveExit: (code: number) => void = () => {};
        const harness = createProcessHarness();
        harness.process.exited = new Promise<number>((resolve) => {
            resolveExit = resolve;
        });
        const client = new AppServerClient(harness.process);
        const pending = client.request("thread/read", { threadId: "thread-1" });

        resolveExit(17);

        await expect(pending).rejects.toThrow("exited with code 17");
        await client.close();
    });
});

test("a wedged stdin never blocks the app-server from being killed", async () => {
    const harness = createProcessHarness();
    let killed: string | undefined;
    const wedged: AppServerProcess = {
        ...harness.process,
        stdin: { ...harness.process.stdin, end: () => new Promise<number>(() => {}) },
        kill(signal) {
            killed = String(signal ?? "SIGTERM");
            harness.process.kill(signal);
        },
    };
    const client = new AppServerClient(wedged, {});

    await client.close();

    expect(killed).toBe("SIGTERM");
    expect(await wedged.exited).toBe(0);
});

describe("appServerCommand", () => {
    test("stays fail-closed: argv never contains the hook-trust bypass", () => {
        expect(appServerCommand("/opt/codex", { config: ["sandbox_mode=read-only"] })).toEqual([
            "/opt/codex",
            "app-server",
            "-c",
            "sandbox_mode=read-only",
        ]);
        expect(appServerCommand("/opt/codex", {})).toEqual(["/opt/codex", "app-server"]);
        expect(appServerCommand("/opt/codex", {}).includes("--dangerously-bypass-hook-trust")).toBe(false);
    });

    test("the Codex daemon does not pass --dangerously-bypass-hook-trust", () => {
        const source = readFileSync(join(import.meta.dir, "../../../codex/daemon.ts"), "utf8");

        expect(source).not.toContain("bypassHookTrust");
        expect(source).not.toContain("--dangerously-bypass-hook-trust");
    });
});
