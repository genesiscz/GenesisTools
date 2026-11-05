import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { RPC_CANCELLED, RpcError } from "./errors";
import { LineBuffer, Outbox, RpcPeer, type RpcProgress } from "./peer";
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
