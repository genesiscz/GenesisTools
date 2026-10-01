import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { currentTraceId } from "@genesiscz/utils/trace";
import { parseArgv } from "./argv";
import { transcriptFetchDoor, transcriptLiveDoor } from "./doors/transcript";
import type { CallDoor, StreamDoor } from "./doors/types";
import { LineBuffer } from "./protocol";
import { type HubServerHandle, startHubServer } from "./server";

const echoDoor: CallDoor<string[]> = {
    kind: "call",
    name: "echo",
    match: (argv) => (argv[0] === "echo" ? argv.slice(1) : null),
    run: async (words) => ({ stdout: `${words.join(" ")}\n`, stderr: "", exit: 0 }),
};

const throwDoor: CallDoor<true> = {
    kind: "call",
    name: "throw",
    match: (argv) => (argv[0] === "throw" ? true : null),
    run: async () => {
        throw new Error("door broke");
    },
};

const ticksDoor: StreamDoor<number> = {
    kind: "stream",
    name: "ticks",
    match: (argv) => (argv[0] === "ticks" ? Number(argv[1]) : null),
    stream: async (count, ctx) => {
        // One synchronous burst: it must leave as one message.
        for (let index = 0; index < count; index++) {
            ctx.write(`line ${index}`);
        }

        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { stdout: "", stderr: "", exit: 0 };
    },
};

const traceDoor: CallDoor<true> = {
    kind: "call",
    name: "trace",
    match: (argv) => (argv[0] === "trace" ? true : null),
    run: async () => {
        await Bun.sleep(1);
        return { stdout: currentTraceId() ?? "none", stderr: "", exit: 0 };
    },
};

const servers: HubServerHandle[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await server.drain("test");
    }
});

async function start(): Promise<{ socketPath: string; handle: HubServerHandle }> {
    const socketPath = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "s", "hub.sock");
    const handle = await startHubServer({
        socketPath,
        doors: [echoDoor, throwDoor, ticksDoor, traceDoor],
        maxFootprintBytes: Number.MAX_SAFE_INTEGER,
        idleMs: 0,
        checkEveryMs: 60_000,
        callTimeoutMs: 5000,
    });
    if (!handle) {
        throw new Error("server did not start");
    }

    servers.push(handle);
    return { socketPath, handle };
}

interface Client {
    socket: Socket;
    send(message: Record<string, unknown>): void;
    next(): Promise<Record<string, unknown>>;
}

async function connect(socketPath: string): Promise<Client> {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
    });
    const queue: Record<string, unknown>[] = [];
    const waiting: ((message: Record<string, unknown>) => void)[] = [];
    const lines = new LineBuffer();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        for (const line of lines.push(chunk) ?? []) {
            const message = SafeJSON.parse(line, { strict: true });
            const waiter = waiting.shift();
            if (waiter) {
                waiter(message);
            } else {
                queue.push(message);
            }
        }
    });
    return {
        socket,
        send: (message) => socket.write(`${SafeJSON.stringify(message, { strict: true })}\n`),
        next: () => {
            const ready = queue.shift();
            return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
        },
    };
}

describe("hub server", () => {
    it("answers a call through its door, refuses an unknown argv, and survives a bad line and a throwing door", async () => {
        const { socketPath } = await start();
        expect(statSync(socketPath).mode & 0o777).toBe(0o600);
        const client = await connect(socketPath);

        client.send({ id: 1, op: "call", argv: ["echo", "a", "b"] });
        expect(await client.next()).toMatchObject({ id: 1, ok: true, stdout: "a b\n", exit: 0 });

        client.send({ id: 2, op: "call", argv: ["nope"] });
        expect(await client.next()).toEqual({ id: 2, ok: false, code: "unsupported" });

        client.socket.write("{not json\n");
        expect(await client.next()).toMatchObject({ ok: false, code: "bad-request" });

        client.send({ id: 3, op: "call", argv: ["throw"] });
        expect(await client.next()).toMatchObject({ id: 3, ok: true, exit: 1, stderr: "door broke\n" });

        client.send({ id: 4, op: "call", argv: ["echo", "still", "here"] });
        expect(await client.next()).toMatchObject({ id: 4, stdout: "still here\n" });
        client.socket.end();
    });

    it("sends a burst of lines as one message, and ends a subscription on cancel", async () => {
        const { socketPath, handle } = await start();
        const client = await connect(socketPath);
        client.send({ id: 7, op: "subscribe", argv: ["ticks", "3"] });
        expect(await client.next()).toEqual({ id: 7, lines: ["line 0", "line 1", "line 2"] });
        expect(handle.health().subscriptions).toBe(1);

        client.send({ id: 7, op: "cancel" });
        expect(await client.next()).toMatchObject({ id: 7, end: true, reason: "cancelled" });
        expect(handle.health().subscriptions).toBe(0);
        client.socket.end();
    });

    it("ends the subscriptions of a closed connection, and ends open ones with restart on drain", async () => {
        const { socketPath, handle } = await start();
        const closing = await connect(socketPath);
        closing.send({ id: 1, op: "subscribe", argv: ["ticks", "1"] });
        await closing.next();
        closing.socket.destroy();
        await Bun.sleep(100);
        expect(handle.health().subscriptions).toBe(0);

        const client = await connect(socketPath);
        client.send({ id: 2, op: "subscribe", argv: ["ticks", "1"] });
        await client.next();
        servers.splice(servers.indexOf(handle), 1);
        const drained = handle.drain("test");
        expect(await client.next()).toMatchObject({ id: 2, end: true, reason: "restart" });
        await drained;
    });

    it("runs each call under its own trace id, across awaits, and drops one that is not a plain id", async () => {
        const { socketPath } = await start();
        const client = await connect(socketPath);
        client.send({ id: 1, op: "call", argv: ["trace"], traceId: "ab12cd34" });
        client.send({ id: 2, op: "call", argv: ["trace"], traceId: "ef56" });
        client.send({ id: 3, op: "call", argv: ["trace"], traceId: "has space" });
        const answers = [await client.next(), await client.next(), await client.next()];
        const byId = new Map(answers.map((answer) => [answer.id, answer.stdout]));
        expect(byId.get(1)).toBe("ab12cd34");
        expect(byId.get(2)).toBe("ef56");
        expect(byId.get(3)).toBe("none");
        client.socket.end();
    });

    it("does not start a second server on a socket that answers", async () => {
        const { socketPath } = await start();
        const second = await startHubServer({
            socketPath,
            doors: [],
            maxFootprintBytes: Number.MAX_SAFE_INTEGER,
            idleMs: 0,
            checkEveryMs: 60_000,
            callTimeoutMs: 5000,
        });
        expect(second).toBeNull();
    });

    it("two starts at once leave exactly one server on the socket", async () => {
        const socketPath = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "s", "hub.sock");
        const options = {
            socketPath,
            doors: [echoDoor],
            maxFootprintBytes: Number.MAX_SAFE_INTEGER,
            idleMs: 0,
            checkEveryMs: 60_000,
            callTimeoutMs: 5000,
        };
        const started = await Promise.all([startHubServer(options), startHubServer(options)]);
        const handles = started.filter((handle): handle is HubServerHandle => handle !== null);
        servers.push(...handles);

        expect(handles).toHaveLength(1);
    });
});

describe("hub server argv", () => {
    it("parses only the plain shape: an unknown flag, a repeated flag or a missing value is null", () => {
        const shape = { command: ["a", "b"], positionals: 1, flags: { "--json": "bool", "--limit": "value" } } as const;
        expect(parseArgv(["a", "b", "x", "--json", "--limit", "5"], shape)?.flags.get("--limit")).toBe("5");
        expect(parseArgv(["a", "b", "x", "--other"], shape)).toBeNull();
        expect(parseArgv(["a", "b", "x", "--json", "--json"], shape)).toBeNull();
        expect(parseArgv(["a", "b", "x", "--limit"], shape)).toBeNull();
        expect(parseArgv(["a", "b"], shape)).toBeNull();
    });

    it("routes the hub's transcript argv to the fetch and live doors, and anything else to the process", () => {
        expect(transcriptFetchDoor.match(["ai", "sessions", "tail", "s1", "--json", "--limit", "80"])).toEqual({
            query: "s1",
            limit: 80,
            offset: undefined,
        });
        expect(transcriptFetchDoor.match(["ai", "sessions", "tail", "s1", "--json", "--format", "json"])).toBeNull();
        expect(transcriptFetchDoor.match(["ai", "sessions", "tail", "s1", "--json", "--limit", "1.5"])).toBeNull();
        expect(transcriptLiveDoor.match(["ai", "sessions", "tail", "s1", "--live", "--offset", "12"])).toEqual({
            query: "s1",
            offset: 12,
        });
        expect(transcriptLiveDoor.match(["ai", "sessions", "tail", "s1", "--live"])).toBeNull();
    });
});

describe("LineBuffer", () => {
    it("an oversized line is refused even when its newline arrives in the same chunk", () => {
        expect(new LineBuffer(10).push("12345678901\n")).toBeNull();
        expect(new LineBuffer(10).push("short\nalso\n")).toEqual(["short", "also"]);
    });
});
