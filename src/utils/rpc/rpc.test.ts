import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { CHILD_STDIN_HIGH_WATER_BYTES, connectChildStdio } from "./child-stdio";
import { JSON_RPC_ERRORS, RPC_CANCELLED, RpcError } from "./errors";
import { failedCallLevel, LineBuffer, Outbox, RpcPeer, type RpcProgress } from "./peer";
import {
    readLiveServiceEntry,
    type ServiceHost,
    type ServiceHostOptions,
    serviceSocketPath,
    startServiceHost,
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

function serve(call: ConstructorParameters<typeof RpcSocketServer<Role>>[0]["call"]) {
    const socket = join(mkdtempSync(join(tmpdir(), "rpc-")), "s.sock");
    const connections: RpcConnection<Role>[] = [];
    const server = new RpcSocketServer<Role>({
        socket,
        state: () => ({}),
        call,
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

// An internal RpcError (a failed live microphone change) and a refused notification were logged at debug only, so
// neither reached the console; a notification gets no reply, so nobody heard of it.
test("a failed call is a warning when it is internal, info for a notification, and debug for a refused request", () => {
    const refused = new RpcError(1001, "no such display");
    expect(failedCallLevel(refused, false)).toBe("debug");
    expect(failedCallLevel(refused, true)).toBe("info");
    expect(failedCallLevel(new RpcError(JSON_RPC_ERRORS.internal, "the mic did not change"), false)).toBe("warn");
    expect(failedCallLevel(new Error("boom"), false)).toBe("warn");
});

test("a peer logs a refused notification at info and a refused request at debug", async () => {
    const log = logger.scoped("rpc-test").log;
    const info = spyOn(log, "info");
    const debug = spyOn(log, "debug");
    try {
        const peer = new RpcPeer({
            write: (bytes) => bytes.length,
            invalid: "answer",
            log,
            label: "test",
            handle: async () => {
                throw new RpcError(1001, "no such display");
            },
        });
        peer.receive(
            Buffer.from('{"jsonrpc":"2.0","method":"audio.mute"}\n{"jsonrpc":"2.0","id":1,"method":"audio.mute"}\n')
        );
        await peer.queue;
        expect(info.mock.calls.map((call) => call[1])).toContain("test call refused");
        expect(debug.mock.calls.map((call) => call[1])).toContain("test call refused");
    } finally {
        info.mockRestore();
        debug.mockRestore();
    }
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

describe("a peer on a child's stdio", () => {
    function childPipe() {
        const written: string[] = [];
        let stdout!: ReadableStreamDefaultController<Uint8Array>;
        return {
            written,
            emit: (text: string) => stdout.enqueue(new TextEncoder().encode(text)),
            end: () => stdout.close(),
            child: {
                stdin: { write: (chunk: string) => written.push(chunk) },
                stdout: new ReadableStream<Uint8Array>({
                    start(controller) {
                        stdout = controller;
                    },
                }),
            },
        };
    }

    test("the end of stdout rejects every waiting request with the exit reason", async () => {
        const pipe = childPipe();
        const exited = Promise.withResolvers<number>();
        const { peer } = connectChildStdio({
            child: { ...pipe.child, exited: exited.promise },
            exitReason: (code) => `the agent exited with code ${code}`,
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            handle: async () => null,
        });
        const first = peer.request("one", {}, { timeoutMs: 60_000 });
        const second = peer.request("two", {}, { timeoutMs: 60_000 });

        const outcomes = Promise.allSettled([first, second]);

        pipe.end();
        exited.resolve(3);

        expect((await outcomes).map((outcome) => outcome.status === "rejected" && String(outcome.reason))).toEqual([
            "Error: the agent exited with code 3",
            "Error: the agent exited with code 3",
        ]);
        expect(peer.closed).toBe(true);
    });

    test("a last reply without a newline before the end of stdout still resolves its call", async () => {
        const pipe = childPipe();
        const { peer } = connectChildStdio({
            child: pipe.child,
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            handle: async () => null,
        });
        const answered = peer.request("one", {}, { timeoutMs: 60_000 });
        const left = peer.request("two", {}, { timeoutMs: 60_000 });
        const outcomes = Promise.allSettled([answered, left]);

        pipe.emit('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
        pipe.end();

        const [first, second] = await outcomes;
        expect(first).toEqual({ status: "fulfilled", value: { ok: true } });
        expect(second.status === "rejected" && String(second.reason)).toBe("Error: agent closed its stdout");
    });

    test("an exit that settles before the last reply is read still lets that reply resolve its call", async () => {
        const pipe = childPipe();
        const exited = Promise.withResolvers<number>();
        const { peer, ended } = connectChildStdio({
            child: { ...pipe.child, exited: exited.promise },
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            handle: async () => null,
        });
        const answered = peer.request("one", {}, { timeoutMs: 60_000 });
        const left = peer.request("two", {}, { timeoutMs: 60_000 });
        const outcomes = Promise.allSettled([answered, left]);

        exited.resolve(0);
        await Bun.sleep(0);
        expect(peer.closed).toBe(false);
        pipe.emit('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
        pipe.end();

        const [first, second] = await outcomes;
        expect(first).toEqual({ status: "fulfilled", value: { ok: true } });
        expect(second.status === "rejected" && String(second.reason)).toBe("Error: agent exited with code 0");
        await ended;
        expect(peer.closed).toBe(true);
    });

    test("an exit whose stdout stays open (a grandchild holds it) ends the connection after the grace", async () => {
        const pipe = childPipe();
        const { peer, ended } = connectChildStdio({
            child: { ...pipe.child, exited: Promise.resolve(9) },
            exitGraceMs: 20,
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            handle: async () => null,
        });
        const waiting = peer.request("one", {}, { timeoutMs: 60_000 });

        await ended;
        expect(peer.closed).toBe(true);
        await expect(waiting).rejects.toThrow("agent exited with code 9");
    });

    test("a child that stops reading its stdin reaches the backlog limit and its connection ends", async () => {
        const pipe = childPipe();
        const { peer } = connectChildStdio({
            child: {
                ...pipe.child,
                // The pipe is full and stays full: no flush ever finishes.
                stdin: {
                    write: (chunk: string) => pipe.written.push(chunk),
                    flush: () => new Promise<never>(() => {}),
                },
            },
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            handle: async () => null,
        });
        const waiting = peer.request("render.export", {}, { timeoutMs: 60_000 });
        const frame = { text: "x".repeat(1024 * 1024) };

        for (let index = 0; index < 10; index++) {
            peer.notify("frame", frame);
        }

        expect(peer.closed).toBe(true);
        await expect(waiting).rejects.toThrow("stopped reading");
        expect(pipe.written).toHaveLength(1);
    });

    test("past the high-water mark a message waits for the writes before it, in order, and written() waits for it", async () => {
        const pipe = childPipe();
        const flushes: Array<() => void> = [];
        const { peer, written } = connectChildStdio({
            child: {
                ...pipe.child,
                stdin: {
                    write: (chunk: string) => pipe.written.push(chunk),
                    flush: () => new Promise<void>((resolve) => flushes.push(resolve)),
                },
            },
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            handle: async () => null,
        });
        const half = "y".repeat(CHILD_STDIN_HIGH_WATER_BYTES / 2 + 1);
        const methods = () => pipe.written.map((line) => Reflect.get(SafeJSON.parse(line, { strict: true }), "method"));
        let done = false;

        peer.notify("one", { half });
        peer.notify("two", { half });
        peer.notify("three", { half });
        const all = written().then(() => {
            done = true;
        });

        for (const expected of [["one"], ["one", "two"], ["one", "two", "three"]]) {
            await Bun.sleep(0);
            expect(methods()).toEqual(expected);
            expect(done).toBe(false);
            flushes.shift()?.();
        }

        await all;
        expect(done).toBe(true);
        expect(peer.closed).toBe(false);
        peer.close("done");
    });

    test("a dialect without the jsonrpc field writes none and reads messages without it", async () => {
        const pipe = childPipe();
        const notifications: string[] = [];
        const { peer, written } = connectChildStdio({
            child: pipe.child,
            dialect: { jsonrpcField: false, cancel: false, progress: false },
            invalid: "ignore",
            log: logger.scoped("rpc-test").log,
            label: "agent",
            onNotification: ({ method }) => notifications.push(method),
            handle: async ({ method }) => ({ answered: method }),
        });
        const reply = peer.request<{ ok: boolean }>("thread/read", { threadId: "t" });

        pipe.emit('{"method":"turn/started","params":{}}\n{"id":"s-1","method":"approve","params":{}}\n');
        pipe.emit('{"id":1,"result":{"ok":true}}\n');

        expect(await reply).toEqual({ ok: true });
        await Bun.sleep(0);
        await written();
        expect(notifications).toEqual(["turn/started"]);
        expect(pipe.written.map((line) => SafeJSON.parse(line, { strict: true }))).toEqual([
            { id: 1, method: "thread/read", params: { threadId: "t" } },
            { id: "s-1", result: { answered: "approve" } },
        ]);
        expect(pipe.written.join("")).not.toContain("jsonrpc");
        peer.close("done");
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

    // The service reads private data for whoever connects, and `hello` is no login: another account on this Mac must
    // not reach its folder or its socket, whether the start makes the folder or finds it open (umask 022).
    test("a start leaves its folder owner-only (0700) and its socket owner-only (0600)", async () => {
        const base = mkdtempSync(join(tmpdir(), "rpc-host-"));
        const made = join(base, "made");
        const found = join(base, "found");
        mkdirSync(found, { mode: 0o755 });
        chmodSync(found, 0o755);

        for (const dir of [made, found]) {
            expect((await host(dir)).status).toBe("started");
            expect(statSync(dir).mode & 0o777).toBe(0o700);
            expect(statSync(serviceSocketPath(dir)).mode & 0o777).toBe(0o600);
        }
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
