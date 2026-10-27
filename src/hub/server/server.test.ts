import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { currentTraceId } from "@genesiscz/utils/trace";
import { parseArgv } from "./argv";
import { askHubServer, callHubServer } from "./client";
import { agentsToolChangesDoor } from "./doors/changes";
import { proposalListDoor, repoDoor, usageSessionsDoor } from "./doors/frequent";
import { HUB_SERVER_DOORS } from "./doors/index";
import { navConfigureDoor, navListDoor, navRecordDoor } from "./doors/nav";
import { transcriptFetchDoor, transcriptLiveDoor } from "./doors/transcript";
import { type CallDoor, DoorUnsupported, doorlessPrefix, type StreamDoor } from "./doors/types";
import { widgetCallDoor, widgetContextDoor, widgetTasksListDoor } from "./doors/widget";
import { ensureHubServer } from "./ensure";
import { LineBuffer } from "./protocol";
import { type HubServerHandle, startHubServer } from "./server";
import { type RowsWorker, type SessionRowsJob, type SessionRowsRequest, SessionRowsRunner } from "./session-rows";

const echoDoor: CallDoor<string[]> = {
    kind: "call",
    name: "echo",
    command: ["echo"],
    match: (argv) => (argv[0] === "echo" ? argv.slice(1) : null),
    run: async (words) => ({ stdout: `${words.join(" ")}\n`, stderr: "", exit: 0 }),
};

/** Waits until its signal aborts: a door that outlives any deadline. */
const slowDoor: CallDoor<true> = {
    kind: "call",
    name: "slow",
    command: ["slow"],
    match: (argv) => (argv[0] === "slow" ? true : null),
    run: (_parsed, { signal }) =>
        new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "aborted\n", exit: 1 }), {
                once: true,
            });
        }),
};

const throwDoor: CallDoor<true> = {
    kind: "call",
    name: "throw",
    command: ["throw"],
    match: (argv) => (argv[0] === "throw" ? true : null),
    run: async () => {
        throw new Error("door broke");
    },
};

const ticksDoor: StreamDoor<number> = {
    kind: "stream",
    name: "ticks",
    command: ["ticks"],
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
    command: ["trace"],
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
        doors: [echoDoor, throwDoor, ticksDoor, traceDoor, slowDoor],
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

        // A deadline answers 124 with its own message, never as a client cancel.
        client.send({ id: 9, op: "call", argv: ["slow"], timeoutMs: 100 });
        expect(await client.next()).toMatchObject({ id: 9, exit: 124 });

        // A client cancel of an in-flight call answers 130 at once, through the server's own cancel path.
        client.send({ id: 10, op: "call", argv: ["slow"] });
        client.send({ id: 10, op: "cancel" });
        expect(await client.next()).toMatchObject({ id: 10, exit: 130 });

        client.send({ id: 2, op: "call", argv: ["nope"] });
        // The refusal names the prefix nothing answers, so the client skips the server for it from then on.
        expect(await client.next()).toEqual({ id: 2, ok: false, code: "unsupported", noDoor: ["nope"] });
        client.send({ id: 5, op: "subscribe", argv: ["nope", "x"] });
        expect(await client.next()).toEqual({ id: 5, ok: false, code: "unsupported", noDoor: ["nope"] });

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

    it("a drain answers a call in flight with draining at once, and sends nothing more for it", async () => {
        const { socketPath, handle } = await start();
        const client = await connect(socketPath);
        client.send({ id: 7, op: "call", argv: ["slow"] });
        await Bun.sleep(50);
        servers.splice(servers.indexOf(handle), 1);
        const drained = handle.drain("test");
        const answer = await Promise.race([
            client.next(),
            Bun.sleep(1000).then(() => ({ timedOut: "no answer within 1 s; the drain waits for the door" })),
        ]);
        expect(answer).toEqual({ id: 7, ok: false, code: "draining" });
        await drained;
        const late = await Promise.race([client.next(), Bun.sleep(100).then(() => null)]);
        expect(late).toBeNull();
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

describe("hub server cancellation", () => {
    it("a production call door stops before its work when the call was cancelled", async () => {
        const parsed = transcriptFetchDoor.match([
            "ai",
            "sessions",
            "tail",
            "no-such-session",
            "--json",
            "--limit",
            "5",
        ]);
        expect(parsed).not.toBeNull();
        const controller = new AbortController();
        controller.abort();

        const result = await transcriptFetchDoor.run(parsed as NonNullable<typeof parsed>, {
            signal: controller.signal,
        });

        expect(result.exit).toBe(1);
        expect(result.stderr.toLowerCase()).toContain("abort");
    });
});

describe("hub server argv", () => {
    it("parses only the plain shape: an unknown flag, a repeated flag or a missing value is null", () => {
        const shape = { command: ["a", "b"], positionals: 1, flags: { "--json": "bool", "--limit": "value" } } as const;
        expect(parseArgv(["a", "b", "x", "--json", "--limit", "5"], shape)?.flags.get("--limit")).toBe("5");
        expect(parseArgv(["a", "b", "x", "--other"], shape)).toBeNull();
        expect(parseArgv(["a", "b", "x", "--json", "--json"], shape)).toBeNull();
        expect(parseArgv(["a", "b", "x", "--limit"], shape)).toBeNull();
        // `--flag=value` takes any value, a leading "-" included; a bool flag never takes one.
        expect(parseArgv(["a", "b", "x", "--limit=-5"], shape)?.flags.get("--limit")).toBe("-5");
        expect(parseArgv(["a", "b", "x", "--limit=5", "--limit", "6"], shape)).toBeNull();
        expect(parseArgv(["a", "b", "x", "--json=1"], shape)).toBeNull();
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

    it("takes the provider the hub's live tail always names, and leaves an unknown one to the CLI", () => {
        const tail = ["ai", "sessions", "tail", "/p/s1.jsonl", "--json", "--limit", "30", "--provider", "claude"];
        expect(transcriptFetchDoor.match(tail)).toMatchObject({ query: "/p/s1.jsonl", limit: 30, provider: "claude" });
        expect(transcriptFetchDoor.match([...tail.slice(0, -1), "nope"])).toBeNull();
        expect(
            transcriptLiveDoor.match(["ai", "sessions", "tail", "s1", "--live", "--offset", "3", "--provider", "codex"])
        ).toMatchObject({ offset: 3, provider: "codex" });
    });

    it("agents changes: the hub's --tools ask with a full session id; a write, a prefix or another shape runs as a process", () => {
        const id = "1b4001ba-d479-40f2-9e25-b13cb2ef5a13";
        expect(agentsToolChangesDoor.match(["agents", "changes", id, "--tools", "t1, t2,t1", "--json"])).toEqual({
            session: id,
            toolIds: ["t1", "t2"],
        });
        expect(
            agentsToolChangesDoor.match(["agents", "changes", id, "--tools", "t1", "--json", "--store-blobs"])
        ).toBeNull();
        expect(agentsToolChangesDoor.match(["agents", "changes", "1b4001ba", "--tools", "t1", "--json"])).toBeNull();
        expect(agentsToolChangesDoor.match(["agents", "changes", id, "--tool", "t1", "--json"])).toBeNull();
        expect(agentsToolChangesDoor.match(["agents", "changes", id, "--tools", "t1"])).toBeNull();
        expect(agentsToolChangesDoor.match(["agents", "changes", id, "--tools", " , ", "--json"])).toBeNull();
    });

    it("hub repo: absolute paths and the cache flags; a relative path or an unknown flag runs as a process", () => {
        expect(repoDoor.match(["hub", "repo", "/w/a", "/w/b", "--pr", "--max-cache-age", "86400"])).toEqual({
            paths: ["/w/a", "/w/b"],
            withPr: true,
            maxCacheAgeSeconds: 86400,
        });
        expect(repoDoor.match(["hub", "repo", "/w/a", "--fresh", "--max-cache-age", "60"])?.maxCacheAgeSeconds).toBe(0);
        expect(repoDoor.match(["hub", "repo", "w/a"])).toBeNull();
        expect(repoDoor.match(["hub", "repo", "/w/a", "--json"])).toBeNull();
        expect(repoDoor.match(["hub", "repo", "/w/a", "--max-cache-age", "1.5"])).toBeNull();
        expect(repoDoor.match(["hub", "repo"])).toBeNull();
    });

    it("ai usage sessions --json: whole positive numbers only; --provider stays a process", () => {
        expect(usageSessionsDoor.match(["ai", "usage", "sessions", "--json", "--hours", "24", "--min", "10"])).toEqual({
            listing: { hours: 24, minRows: 10 },
            fresh: false,
            cacheWrite: true,
            liveLocations: true,
        });
        expect(
            usageSessionsDoor.match([
                "ai",
                "usage",
                "sessions",
                "--json",
                "--fresh",
                "--no-cache-write",
                "--journal-only",
            ])
        ).toEqual({
            listing: {},
            fresh: true,
            cacheWrite: false,
            liveLocations: false,
        });
        expect(usageSessionsDoor.match(["ai", "usage", "sessions", "--hours", "24"])).toBeNull();
        expect(usageSessionsDoor.match(["ai", "usage", "sessions", "--json", "--hours", "0"])).toBeNull();
        expect(usageSessionsDoor.match(["ai", "usage", "sessions", "--json", "--provider", "claude"])).toBeNull();
    });

    it("hub nav: the record argv the hub sends, free text as --flag=value and --replacing last", () => {
        const record = [
            "hub",
            "nav",
            "record",
            "--id=e1",
            "--at=1700000000000",
            "--actor=user",
            "--title=-starts with a dash",
            '--target={"mode":"inbox"}',
            "--keep=20",
            "--note=why",
        ];
        expect(navRecordDoor.match([...record, "--replacing", "e0", "e00"])).toMatchObject({
            entry: { id: "e1", at: 1_700_000_000_000, actor: "user", title: "-starts with a dash", note: "why" },
            keep: 20,
            replacing: ["e0", "e00"],
            json: false,
        });
        expect(navRecordDoor.match([...record, "--replacing"])).toBeNull();
        expect(navRecordDoor.match([...record, "--replacing", "e0", "--json"])).toBeNull();
        // An actor or a target the CLI refuses: the process prints its error.
        expect(
            navRecordDoor.match(record.map((word) => (word === "--actor=user" ? "--actor=robot" : word)))
        ).toBeNull();
        expect(
            navRecordDoor.match(record.map((word) => (word.startsWith("--target=") ? "--target={" : word)))
        ).toBeNull();
        expect(navRecordDoor.match(record.filter((word) => !word.startsWith("--title=")))).toBeNull();
        expect(navRecordDoor.match(record.map((word) => (word === "--keep=20" ? "--keep=0" : word)))).toBeNull();
        expect(navConfigureDoor.match(["hub", "nav", "configure", "--keep=20"])).toBe(20);
        expect(navConfigureDoor.match(["hub", "nav", "configure"])).toBeNull();
        expect(navListDoor.match(["hub", "nav", "list", "--json", "--limit", "5"])).toEqual({ limit: 5 });
        expect(navListDoor.match(["hub", "nav", "list"])).toBeNull();
    });

    it("hub nav: an entry the door records is the one its list door reads back", async () => {
        const signal = new AbortController().signal;
        const entry = navRecordDoor.match([
            "hub",
            "nav",
            "record",
            "--id=door-entry",
            "--actor=agent",
            "--title=The door's place",
            '--target={"mode":"inbox"}',
            "--json",
        ]);
        expect(entry).not.toBeNull();
        if (!entry) {
            return;
        }

        const stored = await navRecordDoor.run(entry, { signal });
        expect(stored.exit).toBe(0);
        expect(SafeJSON.parse(stored.stdout, { strict: true })).toMatchObject({ entry: { id: "door-entry" } });
        const listed = await navListDoor.run({ limit: 50 }, { signal });
        expect(listed.exit).toBe(0);
        expect(listed.stdout).toContain('"door-entry"');
    });

    it("hub widget call reads bounded regular files asynchronously and keeps process fallback", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hub-door-widget-"));
        const request = join(dir, "request.json");
        const fifo = join(dir, "pipe");
        expect(Bun.spawnSync(["mkfifo", fifo], { env: process.env }).exitCode).toBe(0);
        const call = (path: string) => widgetCallDoor.match(["hub", "widget", "call", "--input", path]);
        const signal = new AbortController().signal;
        expect(call("relative.json")).toBeNull();
        expect(widgetCallDoor.match(["hub", "widget", "--state-root", dir, "call", "--input", request])).toBeNull();
        expect(call(request)).toBe(request);
        const fifoResult = await widgetCallDoor.run(fifo, { signal });
        expect(fifoResult.exit).toBe(1);
        expect(fifoResult.stderr).toContain("regular file");
        writeFileSync(request, "x".repeat(1024 * 1024 + 1));
        expect((await widgetCallDoor.run(request, { signal })).exit).toBe(1);
        writeFileSync(request, SafeJSON.stringify({ action: "capture" }, { strict: true }));
        await expect(widgetCallDoor.run(request, { signal })).rejects.toBeInstanceOf(DoorUnsupported);
        writeFileSync(request, SafeJSON.stringify({ action: "selection", key: null }, { strict: true }));
        expect((await widgetCallDoor.run(request, { signal })).exit).toBe(0);
    });

    it("a FIFO request does not block unrelated server calls", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hub-door-fifo-"));
        const fifo = join(dir, "pipe");
        expect(Bun.spawnSync(["mkfifo", fifo], { env: process.env }).exitCode).toBe(0);
        const request = join(dir, "request.json");
        writeFileSync(request, SafeJSON.stringify({ action: "capture" }, { strict: true }));
        const socketPath = join(dir, "server.sock");
        const handle = await startHubServer({
            socketPath,
            doors: [widgetCallDoor, echoDoor],
            maxFootprintBytes: Number.MAX_SAFE_INTEGER,
            idleMs: 0,
            checkEveryMs: 60_000,
            callTimeoutMs: 1000,
        });
        if (!handle) {
            throw new Error("server did not start");
        }
        servers.push(handle);
        const client = await connect(socketPath);
        client.send({ id: 1, op: "call", argv: ["hub", "widget", "call", "--input", fifo], timeoutMs: 500 });
        client.send({ id: 2, op: "call", argv: ["echo", "alive"] });
        client.send({ id: 3, op: "call", argv: ["hub", "widget", "call", "--input", request] });
        const answers = [await client.next(), await client.next(), await client.next()];
        expect(answers.find((answer) => answer.id === 1)).toMatchObject({ exit: 1 });
        expect(answers.find((answer) => answer.id === 2)).toMatchObject({ exit: 0, stdout: "alive\n" });
        expect(answers.find((answer) => answer.id === 3)).toMatchObject({ ok: false, code: "unsupported" });
        client.socket.end();
    });

    it("hub widget context and tasks list: the widget's shapes, the CLI's defaults", () => {
        expect(widgetContextDoor.match(["hub", "widget", "context", "d_1", "--key", "claude:s1", "--json"])).toEqual({
            id: "d_1",
            key: "claude:s1",
            before: 2,
            after: 2,
        });
        expect(widgetContextDoor.match(["hub", "widget", "context", "d_1", "--key", "k", "--before", "11"])).toBeNull();
        expect(widgetContextDoor.match(["hub", "widget", "context", "d_1"])).toBeNull();
        const list = ["hub", "widget", "tasks", "list", "--json", "--scope", "active", "--limit", "200"];
        expect(widgetTasksListDoor.match(list)).toEqual({ scope: "active", limit: 200 });
        expect(widgetTasksListDoor.match([...list, "--project", "Fixture", "--session", "codex:s1"])).toEqual({
            scope: "active",
            limit: 200,
            projects: ["Fixture"],
            sessions: ["codex:s1"],
        });
        expect(widgetTasksListDoor.match([...list, "--project", "A", "B"])).toBeNull();
        expect(widgetTasksListDoor.match(list.map((word) => (word === "active" ? "later" : word)))).toBeNull();
        expect(widgetTasksListDoor.match(list.map((word) => (word === "200" ? "251" : word)))).toBeNull();
    });

    it("hub proposal list: all four PR flags or none", () => {
        const pr = ["--provider", "gitlab", "--host", "gitlab.example.org", "--project", "group/app", "--number", "12"];
        expect(proposalListDoor.match(["hub", "proposal", "list", "--json", ...pr])).toEqual({
            pr: { provider: "gitlab", host: "gitlab.example.org", project: "group/app", number: 12 },
        });
        expect(proposalListDoor.match(["hub", "proposal", "list", "--json"])).toEqual({});
        expect(proposalListDoor.match(["hub", "proposal", "list", "--json", ...pr.slice(0, 6)])).toBeNull();
        expect(proposalListDoor.match(["hub", "proposal", "list", "--json", ...pr.slice(0, -1), "0"])).toBeNull();
        expect(
            proposalListDoor.match(["hub", "proposal", "list", "--json", "--provider", "bitbucket", ...pr.slice(2)])
        ).toBeNull();
        expect(proposalListDoor.match(["hub", "proposal", "list", ...pr])).toBeNull();
    });
});

describe("SessionRowsRunner", () => {
    const job: SessionRowsJob = { listing: { hours: 24 }, fresh: false, cacheWrite: true, liveLocations: true };

    function fakeWorkers() {
        const workers: Array<RowsWorker & { requests: SessionRowsRequest[]; terminated: boolean }> = [];
        const createWorker = () => {
            const worker = {
                requests: [] as SessionRowsRequest[],
                terminated: false,
                onmessage: null as RowsWorker["onmessage"],
                onerror: null as RowsWorker["onerror"],
                postMessage(request: SessionRowsRequest) {
                    worker.requests.push(request);
                },
                terminate() {
                    worker.terminated = true;
                },
            };
            workers.push(worker);
            return worker;
        };
        return { workers, createWorker };
    }

    it("runs on the worker, and an identical ask while it runs shares the one rebuild", async () => {
        const { workers, createWorker } = fakeWorkers();
        const runner = new SessionRowsRunner({ createWorker, inline: async () => "inline\n" });
        try {
            const first = runner.run(job, "t1");
            const second = runner.run(job, "t2");
            const other = runner.run({ ...job, listing: { hours: 72 } });
            expect(workers).toHaveLength(1);
            expect(workers[0].requests.map((request) => request.listing.hours)).toEqual([24, 72]);
            expect(workers[0].requests[0].traceId).toBe("t1");
            for (const request of workers[0].requests) {
                workers[0].onmessage?.(
                    new MessageEvent("message", {
                        data: { id: request.id, ok: true, text: `${request.listing.hours}\n` },
                    })
                );
            }

            expect(await first).toBe("24\n");
            expect(await second).toBe("24\n");
            expect(await other).toBe("72\n");
            // Done: the next ask starts a rebuild of its own.
            // Left running: stop() below fails it.
            runner.run(job).catch(() => undefined);
            expect(workers[0].requests).toHaveLength(3);
        } finally {
            runner.stop();
        }
    });

    it("expires a silent worker and allows a fresh rebuild", async () => {
        const { workers, createWorker } = fakeWorkers();
        const runner = new SessionRowsRunner({ createWorker, jobTimeoutMs: 20 });
        try {
            const first = runner.run(job);
            const second = runner.run(job);
            const failures = await Promise.allSettled([first, second]);
            expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
            expect(workers[0].terminated).toBe(true);
            const next = runner.run(job);
            expect(workers).toHaveLength(2);
            workers[1].onmessage?.(
                new MessageEvent("message", {
                    data: { id: workers[1].requests[0].id, ok: true, text: "fresh\n" },
                })
            );
            expect(await next).toBe("fresh\n");
        } finally {
            runner.stop();
        }
    });

    it("a failed worker fails its asks and the next ask starts a new one; no worker at all runs the job inline", async () => {
        const { workers, createWorker } = fakeWorkers();
        const runner = new SessionRowsRunner({ createWorker, inline: async () => "inline\n" });
        try {
            const failed = runner.run(job);
            workers[0].onerror?.(new ErrorEvent("error", { message: "worker crashed" }));
            await expect(failed).rejects.toThrow("worker crashed");
            expect(workers[0].terminated).toBe(true);
            // Left running: stop() below fails it.
            runner.run(job).catch(() => undefined);
            expect(workers).toHaveLength(2);
        } finally {
            runner.stop();
        }

        const inline = new SessionRowsRunner({
            createWorker: () => {
                throw new Error("no workers here");
            },
            inline: async () => "inline\n",
        });
        expect(await inline.run(job)).toBe("inline\n");
    });
});

describe("doorlessPrefix", () => {
    it("names the shortest prefix no door shares, and nothing while a door could still match", () => {
        const doors = HUB_SERVER_DOORS;
        expect(doorlessPrefix(["hub", "nav", "open", "#12"], doors)).toEqual(["hub", "nav", "open"]);
        expect(doorlessPrefix(["hub", "proposal", "show", "k", "--json"], doors)).toEqual(["hub", "proposal", "show"]);
        expect(doorlessPrefix(["hub", "widget", "snapshot", "--json"], doors)).toEqual(["hub", "widget", "snapshot"]);
        expect(doorlessPrefix(["hub", "widget", "--state-root", "/s", "call"], doors)).toEqual([
            "hub",
            "widget",
            "--state-root",
        ]);
        expect(doorlessPrefix(["ai-spend", "session", "--id", "x"], doors)).toEqual(["ai-spend"]);
        // A door with this command exists, so another shape of it is not cached: the server decides each one.
        expect(doorlessPrefix(["agents", "changes", "id", "--last-turns", "5", "--store-blobs"], doors)).toBeNull();
        expect(doorlessPrefix(["hub", "agents", "unknown"], doors)).toBeNull();
        expect(doorlessPrefix(["hub", "widget", "call", "--input", "/x.json"], doors)).toBeNull();
        expect(doorlessPrefix(["hub", "nav", "record", "--id=1"], doors)).toBeNull();
        for (const door of doors) {
            expect(door.command.length).toBeGreaterThan(0);
        }
    });
});

describe("LineBuffer", () => {
    it("an oversized line is refused even when its newline arrives in the same chunk", () => {
        expect(new LineBuffer(10).push("12345678901\n")).toBeNull();
        expect(new LineBuffer(10).push("short\nalso\n")).toEqual(["short", "also"]);
    });

    it("a line split over many chunks comes out whole, and the limit still counts every chunk", () => {
        const lines = new LineBuffer(20);
        expect(lines.push("abc")).toEqual([]);
        expect(lines.push("def")).toEqual([]);
        expect(lines.push("g\nh")).toEqual(["abcdefg"]);
        expect(lines.push("ij\n")).toEqual(["hij"]);
        const long = new LineBuffer(5);
        expect(long.push("abc")).toEqual([]);
        expect(long.push("def")).toBeNull();
    });
});

describe("callHubServer", () => {
    it("reads a reply that arrives in many chunks, and drops one longer than its limit", async () => {
        const { socketPath } = await start();
        const word = "x".repeat(300_000);
        const answer = await callHubServer({ argv: ["echo", word], timeoutMs: 5000, socketPath });
        expect(answer).toEqual({ stdout: `${word}\n`, stderr: "", exit: 0 });
        expect(
            await callHubServer({ argv: ["echo", word], timeoutMs: 5000, socketPath, maxReplyChars: 1000 })
        ).toBeNull();
    });
});

describe("askHubServer and ensureHubServer", () => {
    it("tells a running server from a missing one, and starts one only when none listens", async () => {
        const { socketPath } = await start();
        const running = await askHubServer("health", { timeoutMs: 2000, socketPath });
        expect(running.state).toBe("answers");

        const gone = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "hub.sock");
        expect((await askHubServer("health", { timeoutMs: 500, socketPath: gone })).state).toBe("absent");

        const stampPath = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "started-at");
        const starts: number[] = [];
        const startOne = () => {
            starts.push(Date.now());
            return 4242;
        };
        const absent = async () => ({ state: "absent" as const });

        expect(await ensureHubServer({ probe: async () => running, start: startOne, stampPath })).toBe("answers");
        expect(await ensureHubServer({ probe: async () => ({ state: "busy" }), start: startOne, stampPath })).toBe(
            "busy"
        );
        expect(starts).toEqual([]);

        expect(await ensureHubServer({ probe: absent, start: startOne, stampPath })).toBe("started");
        expect(await ensureHubServer({ probe: absent, start: startOne, stampPath })).toBe("started recently");
        expect(starts).toHaveLength(1);
        expect(await ensureHubServer({ probe: absent, start: startOne, stampPath, now: Date.now() + 6 * 60_000 })).toBe(
            "started"
        );
        expect(starts).toHaveLength(2);
    });

    it("two callers that find no server at once start it once", async () => {
        const stampPath = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "started-at");
        const starts: number[] = [];
        const absent = async () => ({ state: "absent" as const });
        const startOne = () => {
            starts.push(Date.now());
            return 4242;
        };

        const results = await Promise.all([
            ensureHubServer({ probe: absent, start: startOne, stampPath }),
            ensureHubServer({ probe: absent, start: startOne, stampPath }),
        ]);

        expect(starts).toHaveLength(1);
        expect(results.sort()).toEqual(["started", "started recently"]);
    });

    it("a start that fails is reported, never thrown, so the caller still builds its own answer", async () => {
        const absent = async () => ({ state: "absent" as const });
        const stampPath = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "started-at");
        const failing = () => {
            throw new Error("spawn failed");
        };
        const blocker = join(mkdtempSync(join(tmpdir(), "hubsrv-")), "a-file");
        writeFileSync(blocker, "not a folder");

        expect(await ensureHubServer({ probe: absent, start: failing, stampPath })).toBe("start failed");
        expect(
            await ensureHubServer({ probe: absent, start: () => 4242, stampPath: join(blocker, "started-at") })
        ).toBe("start failed");
    });
});
