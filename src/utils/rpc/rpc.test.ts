import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import { JSON_RPC_ERRORS, RPC_CANCELLED, RpcError } from "./errors";
import { LineBuffer, Outbox, RpcPeer, type RpcProgress } from "./peer";
import {
    readLiveServiceEntry,
    type ServiceHost,
    type ServiceHostOptions,
    serviceEntryPath,
    serviceSocketPath,
    startServiceHost,
    stopService,
} from "./service-host";
import { RpcSocketClient, type RpcSocketClientOptions } from "./socket-client";
import { type RpcConnection, RpcSocketServer } from "./socket-server";

interface Role {
    role?: "host" | "client";
}

const opened: Array<{ close(): void }> = [];

afterEach(() => {
    for (const item of opened.splice(0)) {
        item.close();
    }
});

function serve(
    call: ConstructorParameters<typeof RpcSocketServer<Role>>[0]["call"],
    supersedes?: (method: string) => string | undefined
) {
    const socket = join(mkdtempSync(join(tmpdir(), "rpc-")), "s.sock");
    const connections: RpcConnection<Role>[] = [];
    const server = new RpcSocketServer<Role>({
        socket,
        state: () => ({}),
        call,
        ...(supersedes ? { supersedes } : {}),
        onOpen: (connection) => connections.push(connection),
        logScope: "rpc-test",
        label: "rpc test",
    });
    opened.push({
        close: () => {
            server.endConnections();
            server.stopListening();
        },
    });
    return { socket, server, connections };
}

const roleOf = (params: unknown): Role["role"] =>
    typeof params === "object" && params !== null && Reflect.get(params, "role") === "host" ? "host" : "client";

async function connect(socket: string, onRequest?: RpcSocketClientOptions["onRequest"]) {
    const client = await RpcSocketClient.connect({
        socket,
        logScope: "rpc-test",
        label: "rpc test",
        ...(onRequest ? { onRequest } : {}),
    });
    opened.push(client);
    return client;
}

describe("the JSON-RPC socket server, both directions", () => {
    test("the server asks a client that said hello as host, and the reply comes back by id", async () => {
        const { socket, connections } = serve(async ({ method, params, connection }) => {
            if (method === "hello") {
                connection.state.role = roleOf(params);
                return { ok: true };
            }

            const host = connections.find((each) => each.state.role === "host");

            if (!host) {
                throw new RpcError(1017, "no host");
            }

            return host.request("render.still", params);
        });
        const host = await connect(socket, async ({ method, params }) => ({ method, echoed: params }));
        await host.call("hello", { role: "host" });
        const caller = await connect(socket);

        expect(await caller.call<unknown>("render.still", { atSeconds: 2 })).toEqual({
            method: "render.still",
            echoed: { atSeconds: 2 },
        });
        expect(connections.map((each) => each.state.role)).toEqual(["host", undefined]);
    });

    test("progress restarts the caller's deadline and reaches it; a cancel stops the other side's work", async () => {
        const { socket, connections } = serve(async () => null);
        const started = Promise.withResolvers<void>();
        let sawAbort = false;
        const client = await connect(socket, async (incoming, context) => {
            if (incoming.method === "slow") {
                for (const fraction of [0.25, 0.5]) {
                    await Bun.sleep(30);
                    context.progress({ fraction, label: "rendering" });
                }

                return { done: true };
            }

            started.resolve();
            await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
            sawAbort = true;
            return { late: true };
        });
        await client.call("subscribe", {});
        const [connection] = connections;
        const updates: RpcProgress[] = [];

        // 60 ms of work against a 45 ms deadline: only the progress notifications keep it alive.
        expect(
            await connection.request<unknown>(
                "slow",
                {},
                { timeoutMs: 45, onProgress: (update) => updates.push(update) }
            )
        ).toEqual({ done: true });
        expect(updates).toEqual([
            { fraction: 0.25, label: "rendering" },
            { fraction: 0.5, label: "rendering" },
        ]);

        const controller = new AbortController();
        const waiting = connection.request("export", {}, { signal: controller.signal });
        await started.promise;
        controller.abort();
        await expect(waiting).rejects.toMatchObject({ code: RPC_CANCELLED });
        await Bun.sleep(20);
        expect(sawAbort).toBe(true);
    });

    test("a client's cancel answers its running call with 1013 and the next call still runs", async () => {
        const { socket } = serve(async ({ method, context }) => {
            if (method === "export") {
                await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
            }

            return { method };
        });
        const client = await connect(socket);
        const controller = new AbortController();
        const exporting = client.call("export", {}, { signal: controller.signal });
        await Bun.sleep(10);
        controller.abort();

        await expect(exporting).rejects.toMatchObject({ code: RPC_CANCELLED });
        expect(await client.call<unknown>("status")).toEqual({ method: "status" });
    });

    test("a newer call of a supersede lane cancels the older one that runs and the one that waits", async () => {
        const started: number[] = [];
        const { socket } = serve(
            async ({ method, params, context }) => {
                const n = Number(Reflect.get(Object(params), "n"));
                started.push(n);

                if (method === "cut" && n < 3) {
                    await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
                }

                return { n };
            },
            (method) => (method === "cut" ? "cut" : undefined)
        );
        const client = await connect(socket);
        const first = client.call("cut", { n: 1 });
        await Bun.sleep(10);
        const second = client.call("cut", { n: 2 });
        const third = client.call("cut", { n: 3 });

        const outcomes = await Promise.allSettled([first, second, third]);
        const status = await client.call<unknown>("status", { n: 4 });

        expect(
            outcomes.map((one) => (one.status === "fulfilled" ? one.value : Reflect.get(one.reason, "code")))
        ).toEqual([RPC_CANCELLED, RPC_CANCELLED, { n: 3 }]);
        expect(status).toEqual({ n: 4 });
        expect(started).toEqual([1, 3, 4]);
    });

    test("a client that goes rejects the server's waiting request", async () => {
        const { socket, connections } = serve(async () => null);
        const client = await connect(socket, async () => new Promise(() => undefined));
        await client.call("subscribe", {});
        const waiting = connections[0].request("render.export", {});
        client.close();

        await expect(waiting).rejects.toThrow();
    });
});

test("disconnect settles an abort-ignoring handler and skips queued mutations", async () => {
    const started = Promise.withResolvers<void>();
    const calls: string[] = [];
    const peer = new RpcPeer({
        write: (bytes) => bytes.length,
        invalid: "answer",
        log: logger.scoped("rpc-test").log,
        label: "test",
        handle: async ({ method }) => {
            calls.push(method);
            started.resolve();
            return new Promise(() => undefined);
        },
    });
    peer.receive(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"hang"}\n{"jsonrpc":"2.0","id":2,"method":"mutate"}\n'));
    await started.promise;
    peer.close("disconnected");
    await peer.queue;
    expect(calls).toEqual(["hang"]);
});

test("RPC frames are bounded across fragments and normal lines still decode", () => {
    const lines = new LineBuffer();
    expect(lines.push(Buffer.from("ok\npart"))).toEqual(["ok"]);
    expect(lines.push(Buffer.from("ial\n"))).toEqual(["partial"]);
    lines.push(Buffer.alloc(8 * 1024 * 1024, 97));
    expect(() => lines.push(Buffer.from("a"))).toThrow("exceeds");
});

test("an oversized socket frame ends both adapters and removes the server connection", async () => {
    const socket = join(mkdtempSync(join(tmpdir(), "rpc-limit-")), "s.sock");
    let closes = 0;
    const server = new RpcSocketServer({
        socket,
        state: () => ({}),
        call: async () => null,
        logScope: "rpc-test",
        label: "rpc limit",
        onClose: () => {
            closes++;
        },
    });
    opened.push({
        close: () => {
            server.endConnections();
            server.stopListening();
        },
    });
    const client = await connect(socket);
    const closed = Promise.withResolvers<void>();
    let notifications = 0;
    client.onClose(() => {
        notifications++;
        closed.resolve();
    });
    client.notify("oversized", { text: "a".repeat(8 * 1024 * 1024) });
    await closed.promise;
    expect(client.closed).toBe(true);
    expect(server.connections).toHaveLength(0);
    expect(closes).toBe(1);
    expect(notifications).toBe(1);
});

test("an oversized server frame closes the client and rejects its pending call once", async () => {
    const { socket, connections } = serve(async () => new Promise(() => undefined));
    const client = await connect(socket);
    const closed = Promise.withResolvers<void>();
    let notifications = 0;
    client.onClose(() => {
        notifications++;
        closed.resolve();
    });
    const pending = client.call("hang").catch((error: unknown) => error);
    connections[0].notify("oversized", { text: "a".repeat(8 * 1024 * 1024) });
    await closed.promise;
    expect(client.closed).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(notifications).toBe(1);
});

describe("the outbox of a reader that stops reading", () => {
    test("holds what the socket did not take and sends it, in order, on the next drain", () => {
        let room = 0;
        const sent: string[] = [];
        const outbox = new Outbox((bytes) => {
            const taken = Math.min(room, bytes.length);
            sent.push(bytes.subarray(0, taken).toString());
            room -= taken;
            return taken;
        });
        outbox.send("one\n");
        outbox.send("two\n");
        expect(outbox.pending).toBe(8);

        room = 6;
        outbox.flush();
        expect(sent.join("")).toBe("one\ntw");
        expect(outbox.pending).toBe(2);

        room = 100;
        outbox.flush();
        expect(sent.join("")).toBe("one\ntwo\n");
        expect(outbox.pending).toBe(0);
    });

    test("past its limit it reports once and drops that message and every later one", () => {
        const full: number[] = [];
        const outbox = new Outbox(
            () => 0,
            (bytes) => full.push(bytes),
            10
        );
        outbox.send("12345\n");
        outbox.send("abcd\n");
        outbox.send("more\n");

        expect(full).toEqual([11]);
        expect(outbox.pending).toBe(0);
    });

    test("a peer whose other side stopped reading closes and asks for its socket to end", async () => {
        let ended = 0;
        const peer = new RpcPeer({
            write: () => 0,
            invalid: "answer",
            log: logger.scoped("rpc-test").log,
            label: "test",
            handle: async () => null,
            onBacklogFull: () => {
                ended += 1;
            },
        });
        const waiting = peer.request("render.export", {}, { timeoutMs: 60_000 });
        const frame = { text: "x".repeat(1024 * 1024) };

        for (let index = 0; index < 10; index++) {
            peer.notify("frame", frame);
        }

        expect(ended).toBe(1);
        expect(peer.closed).toBe(true);
        await expect(waiting).rejects.toThrow("stopped reading");
    });
});

describe("the service host (service-host.ts)", () => {
    const hosted: Array<ServiceHost<Role>> = [];

    afterEach(() => {
        for (const host of hosted.splice(0)) {
            host.stop("test end");
        }
    });

    async function host(dir: string, options: Partial<ServiceHostOptions<Role>> = {}) {
        const start = await startServiceHost<Role>({
            dir,
            label: "test service",
            logScope: "rpc-test",
            protocol: 7,
            code: "code-a",
            state: () => ({}),
            call: async ({ method, params, connection }) => {
                if (method === "hello") {
                    connection.state.role = roleOf(params);
                }

                return { method };
            },
            idleMs: 0,
            rivalWaitMs: 500,
            ...options,
        });

        if (start.status === "started") {
            hosted.push(start.host);
        }

        return start;
    }

    test("a start writes service.json with its protocol and code; a second start in the folder answers running", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const first = await host(dir);

        expect(first.status).toBe("started");
        expect(readLiveServiceEntry(dir)).toMatchObject({ protocol: 7, code: "code-a", pid: process.pid });
        expect(await host(dir)).toMatchObject({ status: "running", entry: { pid: process.pid } });
    });

    test("subscribe reaches onSubscribe with its own params, and emit passes the service's filter", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const seen: unknown[] = [];
        const start = await host(dir, { onSubscribe: (_connection, params) => seen.push(params) });

        if (start.status !== "started") {
            throw new Error("the host did not start");
        }

        const client = await connect(serviceSocketPath(dir));
        const heard: unknown[] = [];
        client.onNotification((notification) => heard.push(notification));
        await client.call("hello", { role: "host" });
        await client.call("subscribe", { events: ["thing.changed"], meeting: "m1" });
        start.host.emit("thing.changed", { n: 1 }, (connection) => connection.state.role === "client");
        start.host.emit("thing.changed", { n: 2 }, (connection) => connection.state.role === "host");
        await client.call("hello", { role: "host" });

        expect(seen).toEqual([{ events: ["thing.changed"], meeting: "m1" }]);
        expect(heard).toEqual([{ method: "thing.changed", params: { n: 2 } }]);
    });

    test("unsubscribe ends the subscription; a filter that does not read is refused and keeps the one before", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const start = await host(dir, {
            onSubscribe: (_connection, params) => {
                if (typeof params === "object" && params !== null && Reflect.get(params, "meeting") === "") {
                    throw new RpcError(JSON_RPC_ERRORS.invalidParams, "subscribe: meeting: too small");
                }
            },
        });

        if (start.status !== "started") {
            throw new Error("the host did not start");
        }

        const client = await connect(serviceSocketPath(dir));
        const heard: unknown[] = [];
        client.onNotification((notification) => heard.push(notification));
        await client.call("subscribe", { events: ["thing.changed"] });
        await expect(client.call("subscribe", { events: "thing.changed" })).rejects.toMatchObject({ code: -32602 });
        await expect(client.call("subscribe", { meeting: "" })).rejects.toMatchObject({ code: -32602 });
        start.host.emit("thing.changed", { n: 1 });
        start.host.emit("other.changed", { n: 2 });
        expect(await client.call<{ events: string[] }>("unsubscribe", {})).toEqual({ events: [] });
        start.host.emit("thing.changed", { n: 3 });
        await client.call("hello", { role: "client" });

        expect(heard).toEqual([{ method: "thing.changed", params: { n: 1 } }]);
    });

    test("service.json names the source root it was given", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        await host(dir, { sourceRoot: "/checkouts/genesis tools/" });

        expect(readLiveServiceEntry(dir)?.sourceRoot).toBe("/checkouts/genesis tools/");
    });

    test("a service.json whose pid now runs another command reads as no service, and stop signals nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const entry = {
            version: 1,
            protocol: 7,
            pid: process.pid,
            pidCommand: "bun meetings serve (a process this pid ran before)",
            socket: serviceSocketPath(dir),
            startedAt: "2026-11-09T20:00:00.000Z",
            codeStamp: 0,
        };
        writeFileSync(serviceEntryPath(dir), SafeJSON.stringify(entry, { strict: true }));

        expect(readLiveServiceEntry(dir)).toBeUndefined();
        expect(await stopService(dir)).toEqual({ status: "none" });
        writeFileSync(
            serviceEntryPath(dir),
            SafeJSON.stringify({ ...entry, pidCommand: readProcessCommand(process.pid) }, { strict: true })
        );
        expect(readLiveServiceEntry(dir)?.pid).toBe(process.pid);
    });

    test("stop signals the verified service process and waits until it is gone", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore", env: process.env });
        opened.push({ close: () => child.kill() });
        const pidCommand = readProcessCommand(child.pid);
        const entry = {
            version: 1,
            protocol: 7,
            pid: child.pid,
            ...(pidCommand ? { pidCommand } : {}),
            socket: serviceSocketPath(dir),
            startedAt: "2026-11-09T20:00:00.000Z",
            codeStamp: 0,
        };
        writeFileSync(serviceEntryPath(dir), SafeJSON.stringify(entry, { strict: true }));

        expect(await stopService(dir, { timeoutMs: 3_000 })).toMatchObject({
            status: "stopped",
            entry: { pid: child.pid },
        });
        expect(await child.exited).not.toBe(0);
    });

    test("an idle service with no connection stops and removes its files", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const start = await host(dir, { idleMs: 1, checkEveryMs: 20 });

        if (start.status !== "started") {
            throw new Error("the host did not start");
        }

        expect(await start.host.stopped).toBe("idle");
        expect(readLiveServiceEntry(dir)).toBeUndefined();
        expect(existsSync(serviceSocketPath(dir))).toBe(false);
    });

    test("a service with a live connection does not stop for idleness", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const start = await host(dir, { idleMs: 1, checkEveryMs: 20 });

        if (start.status !== "started") {
            throw new Error("the host did not start");
        }

        const client = await connect(serviceSocketPath(dir));
        await client.call("hello", { role: "client" });
        const outcome = await Promise.race([start.host.stopped, Bun.sleep(120).then(() => "running")]);

        expect(outcome).toBe("running");
        expect(start.host.connections).toHaveLength(1);
    });
});
