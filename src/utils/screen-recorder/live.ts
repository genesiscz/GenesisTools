import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { JobInfo } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import type { Socket } from "bun";
import { z } from "zod";
import {
    type AudioDevices,
    type AudioSource,
    type AudioState,
    type DisplayEntry,
    type DisplayMode,
    type DisplaySelection,
    isRecorderMethod,
    RECORDER_DISPATCH,
    RECORDER_METHODS,
    RecorderControl,
    type RecorderMethod,
    type RecorderSettingsPatch,
    type RecorderState,
    type RecorderStatus,
    RPC_ERRORS,
    RpcError,
    type SettingsAnswer,
    type StopAnswer,
} from "./control";

const { log } = logger.scoped("live-recordings");

export const LIVE_COMMANDS = ["pause", "resume", "stop"] as const;
export type LiveCommand = (typeof LIVE_COMMANDS)[number];
export const LIVE_STATES = ["recording", "paused", "stopping"] as const;
export type LiveState = (typeof LIVE_STATES)[number];
export const LIVE_EVENTS = ["state", "frame", "displays", "warning", "progress", "ended"] as const;
export type LiveEvent = (typeof LIVE_EVENTS)[number];

/** macOS refuses a Unix socket path longer than 103 bytes. */
const MAX_SOCKET_PATH = 103;
const CALL_TIMEOUT_MS = 10_000;
/** A stop that waits answers after OCR, the summary and the collect; a long backlog takes minutes. */
const STOP_TIMEOUT_MS = 10 * 60_000;

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
    /** The RPC methods this recording serves (`RECORDER_METHODS`); the menu bar shows a button per control. */
    controls: z.array(z.string()).default([...LIVE_COMMANDS]),
    /** The JSON-RPC socket that controls the recording. */
    socket: z.string(),
});
export type LiveEntry = z.infer<typeof liveEntrySchema>;

export { RPC_ERRORS, RpcError } from "./control";

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

export type LiveEntryChange = Partial<
    Pick<LiveEntry, "title" | "state" | "displays" | "frames" | "lastFrameAt" | "warning">
>;

/**
 * The live recording of one recorder in this process: the `<id>.json` discovery entry, written on every change, and a
 * JSON-RPC 2.0 server on its socket (one message per line) that serves the recorder's RecorderControl, plus
 * `subscribe`. `close()` notifies `ended`, ends every connection after its last answer and removes both files.
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
        control: RecorderControl;
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

        const control = options.control;
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
                        client.data.queue = client.data.queue.then(() => this.handle(client, line, control));
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
            controls: [...control.methods],
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

        // Answers already written go out before the connection ends; `stop(true)` would cut them off.
        for (const client of this.connections) {
            client.data.outbox.flush();
            client.end();
        }

        this.listener.stop();

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

    private async handle(client: Socket<Connection>, line: string, control: RecorderControl): Promise<void> {
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
                if (!isRecorderMethod(method)) {
                    throw new RpcError(RPC_ERRORS.methodNotFound, `unknown method ${method}`);
                }

                if (!control.methods.includes(method)) {
                    throw new RpcError(RPC_ERRORS.unsupported, `a ${control.kind} recording has no ${method}`);
                }

                result = await RECORDER_DISPATCH[method](control, params);
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

/**
 * A running recording over its socket, as a RecorderControl: the same methods in-process and remote, so the menu bar,
 * a REPL and the CLI call one method set for every recorder kind. `call` and `subscribe` stay for the raw protocol.
 */
export class RecorderClient extends RecorderControl {
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Set<(notification: LiveNotification) => void>();
    private readonly lines = new LineBuffer();
    private socket?: Socket<undefined>;
    private outbox?: Outbox;
    private closedReason?: string;

    readonly kind: string;
    readonly methods: readonly RecorderMethod[];

    private constructor(readonly entry: LiveEntry) {
        super();
        this.kind = entry.kind;
        this.methods = RECORDER_METHODS.filter((method) => entry.controls.includes(method));
    }

    status(): Promise<RecorderStatus> {
        return this.call<RecorderStatus>("status");
    }

    pause(): Promise<{ state: RecorderState }> {
        return this.call("pause");
    }

    resume(): Promise<{ state: RecorderState }> {
        return this.call("resume");
    }

    /** Waits for post-processing unless `wait` is false; post-processing can outlast the normal call deadline. */
    stop(options: { wait?: boolean } = {}): Promise<StopAnswer> {
        return this.call<StopAnswer>("stop", options, options.wait === false ? CALL_TIMEOUT_MS : STOP_TIMEOUT_MS);
    }

    override discard(): Promise<StopAnswer> {
        return this.call("discard");
    }

    override restart(): Promise<{ state: RecorderState }> {
        return this.call("restart");
    }

    override switchTarget(target: unknown): Promise<{ state: RecorderState }> {
        return this.call("target.switch", { target });
    }

    override listDisplays(): Promise<DisplayEntry[]> {
        return this.call("displays.list");
    }

    override addDisplay(displayId: number): Promise<DisplaySelection> {
        return this.call("displays.add", { displayId });
    }

    override removeDisplay(displayId: number): Promise<DisplaySelection> {
        return this.call("displays.remove", { displayId });
    }

    override switchDisplay(displayId: number): Promise<DisplaySelection> {
        return this.call("displays.switch", { displayId });
    }

    override setDisplayMode(mode: DisplayMode): Promise<DisplaySelection> {
        return this.call("displays.mode", { mode });
    }

    override listJobs(): Promise<JobInfo[]> {
        return this.call("jobs.list");
    }

    override listAudioDevices(): Promise<AudioDevices> {
        return this.call("audio.list");
    }

    override muteAudio(source: AudioSource, muted: boolean): Promise<AudioState> {
        return this.call("audio.mute", { source, muted });
    }

    override setAudioInput(deviceId: string): Promise<AudioState> {
        return this.call("audio.setInput", { deviceId });
    }

    override getSettings(): Promise<SettingsAnswer> {
        return this.call("settings.get");
    }

    override setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        return this.call("settings.set", patch);
    }

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
