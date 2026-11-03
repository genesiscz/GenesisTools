import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import type { Socket } from "bun";
import { z } from "zod";

const { log } = logger.scoped("live-recordings");

export const LIVE_COMMANDS = ["pause", "resume", "stop"] as const;
export type LiveCommand = (typeof LIVE_COMMANDS)[number];
export const LIVE_STATES = ["recording", "paused", "stopping"] as const;
export type LiveState = (typeof LIVE_STATES)[number];
export const LIVE_EVENTS = ["state", "frame", "displays", "warning", "ended"] as const;
export type LiveEvent = (typeof LIVE_EVENTS)[number];

/** macOS refuses a Unix socket path longer than 103 bytes. */
const MAX_SOCKET_PATH = 103;
const CALL_TIMEOUT_MS = 10_000;

export const liveEntrySchema = z.object({
    version: z.literal(1),
    id: z.string().min(1),
    /** `meeting`, `control-session`, or another recorder's own kind. */
    kind: z.string().min(1),
    title: z.string(),
    pid: z.number().int().positive(),
    /** The recorder's command line when it wrote the entry, so a recycled pid reads as gone. */
    pidCommand: z.string().optional(),
    startedAt: z.string(),
    state: z.enum(LIVE_STATES),
    displays: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
    frames: z.number().int().nonnegative().default(0),
    lastFrameAt: z.string().optional(),
    warning: z.string().optional(),
    folder: z.string().optional(),
    controls: z.array(z.enum(LIVE_COMMANDS)).default([...LIVE_COMMANDS]),
    /** The JSON-RPC socket that controls the recording. */
    socket: z.string(),
});
export type LiveEntry = z.infer<typeof liveEntrySchema>;

/** JSON-RPC 2.0 error codes: the standard ones, and the recorder's own from 1001. */
export const RPC_ERRORS = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    unknownDisplay: 1001,
    notPaused: 1002,
    alreadyStopped: 1003,
    alreadyPaused: 1004,
    lastDisplay: 1005,
} as const;

export class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "RpcError";
    }
}

const rpcRequest = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
});
const rpcMessage = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

/** `<genesis-tools root>/recordings/live/`: one `<id>.json` per running recording, and its `<id>.sock`. */
export function liveRecordingsDir(): string {
    return genesisToolsDir("recordings", "live");
}

/** A file-name-safe id: `meeting-2026-11-03_15-30-planning`. */
export function liveRecordingId(kind: string, key: string): string {
    return `${kind}-${key}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

/** `<id>.sock`, or a hash of the id when that path would be too long for a Unix socket. */
export function liveSocketPath(dir: string, id: string): string {
    const plain = join(dir, `${id}.sock`);
    return Buffer.byteLength(plain) <= MAX_SOCKET_PATH
        ? plain
        : join(dir, `${createHash("sha1").update(id).digest("hex").slice(0, 16)}.sock`);
}

function parseOrNull(text: string): unknown {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        log.debug({ error }, "live recording text is not JSON");
        return null;
    }
}

/** False when the entry's process ended or its pid now belongs to another program. */
export function isLiveEntryAlive(entry: LiveEntry): boolean {
    const status = classifyPid(entry.pid, entry.pidCommand).status;
    return status === "live" || status === "unverified";
}

/** The running recordings, for a UI. An entry whose process is gone is left out, never deleted here. */
export function listLiveRecordings(dir = liveRecordingsDir()): LiveEntry[] {
    if (!existsSync(dir)) {
        return [];
    }

    const entries: LiveEntry[] = [];

    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) {
            continue;
        }

        const parsed = liveEntrySchema.safeParse(parseOrNull(readFileSync(join(dir, name), "utf8")));

        if (!parsed.success) {
            log.debug({ name, issues: parsed.error.issues }, "unreadable live recording entry");
            continue;
        }

        if (isLiveEntryAlive(parsed.data)) {
            entries.push(parsed.data);
        }
    }

    return entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function readLiveRecording(id: string, dir = liveRecordingsDir()): LiveEntry | undefined {
    return listLiveRecordings(dir).find((entry) => entry.id === id);
}

/** Splits a byte stream into lines; a partial line waits for its newline. */
class LineBuffer {
    private pending = "";
    private readonly decoder = new TextDecoder();

    push(chunk: Uint8Array): string[] {
        this.pending += this.decoder.decode(chunk, { stream: true });
        const lines = this.pending.split("\n");
        this.pending = lines.pop() ?? "";
        return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim());
    }
}

/** Writes a whole message even when the socket takes only part of it now; the rest goes on `drain`. */
class Outbox {
    private queued: Buffer = Buffer.alloc(0);

    constructor(private readonly write: (bytes: Buffer) => number) {}

    send(text: string): void {
        this.queued = Buffer.concat([this.queued, Buffer.from(text)]);
        this.flush();
    }

    flush(): void {
        if (this.queued.length === 0) {
            return;
        }

        const written = this.write(this.queued);
        this.queued = this.queued.subarray(Math.max(0, written));
    }
}

interface Connection {
    lines: LineBuffer;
    outbox: Outbox;
    /** The requests of one connection are answered one after another, in the order they came. */
    queue: Promise<void>;
    /** The events this connection subscribed to (empty: all of them); undefined until it calls `subscribe`. */
    events?: Set<string>;
}

export type LiveMethod = (params: unknown) => unknown | Promise<unknown>;

export type LiveEntryChange = Partial<
    Pick<LiveEntry, "title" | "state" | "displays" | "frames" | "lastFrameAt" | "warning">
>;

/**
 * The live recording of one recorder in this process: the `<id>.json` discovery entry, written on every change, and a
 * JSON-RPC 2.0 server on its socket (one message per line). `status` and `subscribe` are built in; the recorder
 * supplies the rest (`pause`, `resume`, `stop`, `displays.*`). `close()` notifies `ended` and removes both files.
 */
export class LiveRecordingServer {
    private entry: LiveEntry;
    private readonly entryPath: string;
    private readonly listener: ReturnType<typeof Bun.listen<Connection>>;
    private readonly connections = new Set<Socket<Connection>>();
    private closed = false;

    constructor(options: {
        id: string;
        kind: string;
        title: string;
        folder?: string;
        displays?: LiveEntry["displays"];
        controls?: LiveCommand[];
        methods: Record<string, LiveMethod>;
        dir?: string;
    }) {
        const dir = options.dir ?? liveRecordingsDir();
        mkdirSync(dir, { recursive: true });
        this.entryPath = join(dir, `${options.id}.json`);
        const socket = liveSocketPath(dir, options.id);

        // A socket file left by a recorder that died; this process now owns the id.
        if (existsSync(socket)) {
            unlinkSync(socket);
        }

        const methods: Record<string, LiveMethod> = { status: () => this.current, ...options.methods };
        this.listener = Bun.listen<Connection>({
            unix: socket,
            socket: {
                open: (client) => {
                    client.data = {
                        lines: new LineBuffer(),
                        outbox: new Outbox((bytes) => client.write(bytes)),
                        queue: Promise.resolve(),
                    };
                    this.connections.add(client);
                },
                data: (client, chunk) => {
                    for (const line of client.data.lines.push(chunk)) {
                        client.data.queue = client.data.queue.then(() => this.handle(client, line, methods));
                    }
                },
                drain: (client) => client.data.outbox.flush(),
                close: (client) => {
                    this.connections.delete(client);
                },
                error: (client, error) => {
                    log.debug({ error }, "live recording connection error");
                    this.connections.delete(client);
                },
            },
        });
        const pidCommand = readProcessCommand(process.pid);
        this.entry = {
            version: 1,
            id: options.id,
            kind: options.kind,
            title: options.title,
            pid: process.pid,
            ...(pidCommand ? { pidCommand } : {}),
            startedAt: new Date().toISOString(),
            state: "recording",
            displays: options.displays ?? [],
            frames: 0,
            ...(options.folder ? { folder: options.folder } : {}),
            controls: options.controls ?? [...LIVE_COMMANDS],
            socket,
        };
        this.write();
        log.info({ id: options.id, kind: options.kind, socket }, "live recording listening");
    }

    get id(): string {
        return this.entry.id;
    }

    get current(): LiveEntry {
        return { ...this.entry };
    }

    update(change: LiveEntryChange): void {
        if (this.closed) {
            return;
        }

        const before = this.entry;
        this.entry = { ...this.entry, ...change };

        if ("warning" in change && change.warning === undefined) {
            delete this.entry.warning;
        }

        this.write();

        if (change.state && change.state !== before.state) {
            this.emit("state", { state: change.state });
        }

        if (change.warning && change.warning !== before.warning) {
            this.emit("warning", { warning: change.warning });
        }
    }

    /** A notification to every connection that subscribed to `event`. */
    emit(event: LiveEvent, params: Record<string, unknown>): void {
        const message = `${SafeJSON.stringify({ jsonrpc: "2.0", method: event, params })}\n`;

        for (const client of this.connections) {
            const wanted = client.data.events;

            if (wanted && (wanted.size === 0 || wanted.has(event))) {
                client.data.outbox.send(message);
            }
        }
    }

    /** Notifies `ended`, closes the socket and removes the entry and the socket file. */
    close(reason?: string): void {
        if (this.closed) {
            return;
        }

        this.emit("ended", reason ? { reason } : {});
        this.closed = true;
        this.listener.stop(true);

        for (const path of [this.entryPath, this.entry.socket]) {
            if (existsSync(path)) {
                unlinkSync(path);
            }
        }

        log.info({ id: this.entry.id }, "live recording removed");
    }

    [Symbol.dispose](): void {
        this.close();
    }

    private write(): void {
        atomicWriteFileSync(this.entryPath, SafeJSON.stringify(this.entry, null, 2));
    }

    private async handle(client: Socket<Connection>, line: string, methods: Record<string, LiveMethod>): Promise<void> {
        const parsed = rpcRequest.safeParse(parseOrNull(line));
        const reply = (body: Record<string, unknown>) => {
            client.data.outbox.send(`${SafeJSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
        };

        if (!parsed.success) {
            reply({ id: null, error: { code: RPC_ERRORS.invalidRequest, message: "not a JSON-RPC 2.0 request" } });
            return;
        }

        const { id, method, params } = parsed.data;

        try {
            let result: unknown;

            if (method === "subscribe") {
                const events = z.object({ events: z.array(z.string()).optional() }).safeParse(params ?? {});
                client.data.events = new Set(events.success ? (events.data.events ?? []) : []);
                result = { events: [...client.data.events] };
            } else {
                const handler = methods[method];

                if (!handler) {
                    throw new RpcError(RPC_ERRORS.methodNotFound, `unknown method ${method}`);
                }

                result = await handler(params);
            }

            log.debug({ id: this.entry.id, method }, "live recording call");

            if (id !== undefined) {
                reply({ id, result: result ?? null });
            }
        } catch (error) {
            const code = error instanceof RpcError ? error.code : RPC_ERRORS.internal;
            log.info({ id: this.entry.id, method, error }, "live recording call refused");

            if (id !== undefined) {
                reply({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
            }
        }
    }
}

export interface LiveNotification {
    event: string;
    params: unknown;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** A connection to a running recording's socket. */
export class RecorderClient {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Set<(notification: LiveNotification) => void>();
    private readonly lines = new LineBuffer();
    private socket?: Socket<undefined>;
    private outbox?: Outbox;
    private closedReason?: string;

    private constructor(readonly entry: LiveEntry) {}

    /** Connects by id; throws when no such recording runs or its socket refuses (a stale entry counts as gone). */
    static async connect(id: string, options: { dir?: string } = {}): Promise<RecorderClient> {
        const entry = readLiveRecording(id, options.dir);

        if (!entry) {
            throw new Error(`No running recording "${id}"`);
        }

        const client = new RecorderClient(entry);

        try {
            const socket = await Bun.connect({
                unix: entry.socket,
                socket: {
                    data: (_socket, chunk) => client.receive(chunk),
                    drain: () => client.outbox?.flush(),
                    close: () => client.end("the recording closed the connection"),
                    error: (_socket, error) => client.end(error.message),
                },
            });
            client.socket = socket;
            client.outbox = new Outbox((bytes) => socket.write(bytes));
        } catch (error) {
            log.debug({ error, id, socket: entry.socket }, "live recording socket refused");
            throw new Error(`No running recording "${id}" (its socket does not answer)`);
        }

        return client;
    }

    /** One JSON-RPC call; an error reply rejects with an RpcError that carries its code. */
    call<T = unknown>(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
        if (this.closedReason) {
            return Promise.reject(new Error(this.closedReason));
        }

        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method}: no answer within ${timeoutMs / 1000} s`));
            }, timeoutMs);
            this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
            const params_ = params !== undefined ? { params } : {};
            this.outbox?.send(`${SafeJSON.stringify({ jsonrpc: "2.0", id, method, ...params_ })}\n`);
        });
    }

    /** Receives notifications from now on: all of them, or only `events`. */
    async subscribe(onEvent: (notification: LiveNotification) => void, events?: LiveEvent[]): Promise<void> {
        this.listeners.add(onEvent);
        await this.call("subscribe", events ? { events } : {});
    }

    close(): void {
        this.socket?.end();
        this.end("closed");
    }

    private receive(chunk: Uint8Array): void {
        for (const line of this.lines.push(chunk)) {
            const parsed = rpcMessage.safeParse(parseOrNull(line));

            if (!parsed.success) {
                log.debug({ line }, "unreadable live recording message");
                continue;
            }

            const message = parsed.data;

            if (message.method) {
                for (const listener of this.listeners) {
                    listener({ event: message.method, params: message.params });
                }

                continue;
            }

            const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;

            if (!waiting || typeof message.id !== "number") {
                continue;
            }

            this.pending.delete(message.id);
            clearTimeout(waiting.timer);

            if (message.error) {
                waiting.reject(new RpcError(message.error.code, message.error.message, message.error.data));
            } else {
                waiting.resolve(message.result);
            }
        }
    }

    private end(reason: string): void {
        if (this.closedReason) {
            return;
        }

        this.closedReason = reason;

        for (const [id, waiting] of this.pending) {
            clearTimeout(waiting.timer);
            waiting.reject(new Error(reason));
            this.pending.delete(id);
        }
    }
}

/** Connects, makes one call, and closes: what a CLI command needs. */
export async function callRecorder<T = unknown>(options: {
    id: string;
    method: string;
    params?: unknown;
    dir?: string;
}): Promise<T> {
    const client = await RecorderClient.connect(options.id, { dir: options.dir });

    try {
        return await client.call<T>(options.method, options.params);
    } finally {
        client.close();
    }
}
