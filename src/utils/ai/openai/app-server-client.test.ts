import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { AppServerClient, type AppServerProcess } from "./app-server-client";

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
            exited: new Promise<number>(() => {}),
            kill() {},
        },
        writes,
        push(message) {
            stdoutController?.enqueue(encoder.encode(`${SafeJSON.stringify(message, { strict: true })}\n`));
        },
    };
}

describe("AppServerClient", () => {
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
        const client = new AppServerClient(harness.process, {
            onNotification: async (notification) => {
                await Bun.sleep(notification.method === "first" ? 5 : 0);
                seen.push(notification.method);
            },
        });

        harness.push({ method: "first", params: {} });
        harness.push({ method: "second", params: {} });
        await Bun.sleep(30);

        expect(seen).toEqual(["first", "second"]);
        await client.close();
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
