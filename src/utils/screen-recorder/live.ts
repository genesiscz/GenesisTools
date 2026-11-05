import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { JobInfo } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { classifyPid, readProcessCommand } from "@genesiscz/utils/process-identity";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { RpcSocketServer } from "@genesiscz/utils/rpc/socket-server";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
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
    RECORDER_STATES,
    RecorderControl,
    type RecorderMethod,
    type RecorderSettingsPatch,
    type RecorderState,
    type RecorderStatus,
    type RecordingMarker,
    RPC_ERRORS,
    RpcError,
    type SettingsAnswer,
    type StopAnswer,
} from "./control";
// service-link imports this module back; neither touches the other's exports before a call, so the cycle is safe.
import { connectRecordingViaService, recorderServiceDir, type ServiceJoin, ServiceRegistration } from "./service-link";

const { log } = logger.scoped("live-recordings");

export const LIVE_COMMANDS = ["pause", "resume", "stop"] as const;
export type LiveCommand = (typeof LIVE_COMMANDS)[number];
export const LIVE_STATES = RECORDER_STATES;
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
    /** Asks the menu bar host to open the recording's floating controls once it sees the entry. */
    panel: z.boolean().optional(),
});
export type LiveEntry = z.infer<typeof liveEntrySchema>;

export { RPC_ERRORS, RpcError } from "./control";

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

        let text: string;

        try {
            text = readFileSync(join(dir, name), "utf8");
        } catch (error) {
            log.debug({ error, name }, "live recording entry disappeared or is unreadable");
            continue;
        }

        const parsed = liveEntrySchema.safeParse(parseOrNull(text));

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

export type LiveEntryChange = Partial<
    Pick<LiveEntry, "title" | "state" | "displays" | "frames" | "lastFrameAt" | "warning">
>;

/** Methods that answer after the recording's post-processing (OCR, the summary, the collect): a discard waits for it too. */
const FINISHING_METHODS = new Set(["stop", "discard"]);

/**
 * The answer deadline of a call: a `stop` or `discard` that waits for the finish gets the finish's time, any other call
 * the short one.
 */
export function callTimeoutFor(method: string, params: unknown): number {
    const waits = !(typeof params === "object" && params !== null && "wait" in params && params.wait === false);
    return FINISHING_METHODS.has(method) && waits ? STOP_TIMEOUT_MS : CALL_TIMEOUT_MS;
}

/**
 * The live recording of one recorder in this process: the `<id>.json` discovery entry, written on every change, and a
 * JSON-RPC 2.0 server on its socket (one message per line) that serves the recorder's RecorderControl, plus
 * `subscribe`. `close()` notifies `ended`, ends every connection after its last answer and removes both files.
 */
export class LiveRecordingServer {
    private entry: LiveEntry;
    private readonly entryPath: string;
    private readonly server: RpcSocketServer<undefined>;
    private readonly registration?: ServiceRegistration;
    private closed = false;
    private mutations: Promise<unknown> = Promise.resolve();

    constructor(options: {
        id: string;
        kind: string;
        title: string;
        folder?: string;
        displays?: LiveEntry["displays"];
        control: RecorderControl;
        dir?: string;
        /** The host opens the floating controls for it (`tools recorder start`, the menu's Record Screen). */
        panel?: boolean;
        /**
         * The recorder service it joins while one runs: by default the one in `<genesis-tools root>/recordings`; a
         * scratch `dir` joins none unless this names one.
         */
        service?: ServiceJoin;
    }) {
        const dir = options.dir ?? liveRecordingsDir();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        this.entryPath = join(dir, `${options.id}.json`);
        const socket = liveSocketPath(dir, options.id);
        const control = options.control;
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
            ...(options.panel ? { panel: true } : {}),
        };
        // One process at a time decides who owns the id: a live or unreadable entry keeps it, and only a socket file
        // left by a recorder that died is removed. The entry is published under the same lock as the socket.
        this.server = withPathArbitrationSync(socket, () => {
            if (existsSync(this.entryPath)) {
                const previous = liveEntrySchema.safeParse(parseOrNull(readFileSync(this.entryPath, "utf8")));

                if (!previous.success || isLiveEntryAlive(previous.data)) {
                    throw new Error(`Recording "${options.id}" already owns its control socket`);
                }
            }

            if (existsSync(socket)) {
                unlinkSync(socket);
            }

            const listener = this.listen(socket, control);
            // Only the owner may reach the control socket.
            chmodSync(socket, 0o600);
            this.write();
            return listener;
        });
        log.info({ id: options.id, kind: options.kind, socket }, "live recording listening");
        const service = options.service ?? (options.dir ? false : { dir: recorderServiceDir() });

        if (service) {
            this.registration = new ServiceRegistration({
                dir: service.dir,
                ...(service.pollMs ? { pollMs: service.pollMs } : {}),
                entry: () => this.current,
                answer: (method, params) => this.dispatch(control, method, params),
            });
            this.registration.start();
        }
    }

    /** True while the recording is registered with a running recorder service. */
    get joinedService(): boolean {
        return this.registration?.joined ?? false;
    }

    /** Resolves once a join with the service that is under way ended. */
    async serviceSettled(): Promise<void> {
        await this.registration?.settled();
    }

    private listen(socket: string, control: RecorderControl): RpcSocketServer<undefined> {
        return new RpcSocketServer<undefined>({
            socket,
            state: () => undefined,
            call: ({ method, params }) => this.dispatch(control, method, params),
            logScope: "live-recordings",
            label: "live recording",
            logFields: { id: this.entry.id },
        });
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
        this.registration?.changed(change);

        if (change.state && change.state !== before.state) {
            this.emit("state", { state: change.state });
        }

        if ("warning" in change && change.warning !== before.warning) {
            this.emit("warning", { warning: change.warning ?? null });
        }
    }

    /** A notification to every connection that subscribed to `event`. */
    emit(event: LiveEvent, params: Record<string, unknown>): void {
        this.server.emit(event, params);
        this.registration?.event(event, params);
    }

    /** Notifies `ended`, closes the socket and removes the entry and the socket file. */
    close(reason?: string): void {
        if (this.closed) {
            return;
        }

        this.emit("ended", reason ? { reason } : {});
        this.closed = true;
        this.registration?.close();

        // Answers already written go out before the connection ends; `stop(true)` would cut them off.
        this.server.endConnections();

        const remove = () => {
            this.server.stopListening();

            for (const path of [this.entryPath, this.entry.socket]) {
                if (existsSync(path)) {
                    unlinkSync(path);
                }
            }
        };

        // Under the same lock as a start, so a new owner never sees this entry gone while its socket still exists.
        try {
            withPathArbitrationSync(this.entry.socket, remove);
        } catch (error) {
            // A start holding the lock now reads this entry as alive and gives up, so removing without it is safe.
            log.warn({ error, id: this.entry.id }, "live recording socket lock busy; removing without it");
            remove();
        }

        log.info({ id: this.entry.id }, "live recording removed");
    }

    [Symbol.dispose](): void {
        this.close();
    }

    private write(): void {
        atomicWriteFileSync(this.entryPath, SafeJSON.stringify(this.entry, null, 2));
    }

    /** The recorder's methods; the server answers `subscribe` itself. */
    private async dispatch(control: RecorderControl, method: string, params: unknown): Promise<unknown> {
        if (!isRecorderMethod(method)) {
            throw new RpcError(RPC_ERRORS.methodNotFound, `unknown method ${method}`);
        }

        if (!control.methods.includes(method)) {
            throw new RpcError(RPC_ERRORS.unsupported, `a ${control.kind} recording has no ${method}`);
        }

        if (method === "status" || method.endsWith(".list") || method === "settings.get") {
            return RECORDER_DISPATCH[method](control, params);
        }

        // Changes run one after another whichever client sent them, so two clients never interleave a mutation.
        const pending = this.mutations.then(() => RECORDER_DISPATCH[method](control, params));
        this.mutations = pending.catch(() => undefined);
        return pending;
    }
}

export interface LiveNotification {
    event: string;
    params: unknown;
}

/** How a RecorderClient reaches its recording: the recording's own socket, or the recorder service. */
export interface RecorderTransport {
    readonly via: "socket" | "service";
    call<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
    onNotification(listener: (notification: LiveNotification) => void): void;
    /** Starts the recording's notifications; the client filters them by event. */
    subscribe(): Promise<void>;
    close(): void;
}

/** The recording's own control socket. */
class SocketRecorderTransport implements RecorderTransport {
    readonly via = "socket";

    constructor(private readonly rpc: RpcSocketClient) {}

    call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
        return this.rpc.call<T>(method, params, { timeoutMs });
    }

    onNotification(listener: (notification: LiveNotification) => void): void {
        this.rpc.onNotification(({ method, params }) => listener({ event: method, params }));
    }

    async subscribe(): Promise<void> {
        await this.rpc.call("subscribe", {});
    }

    close(): void {
        this.rpc.close();
    }
}

/**
 * A running recording as a RecorderControl: the same methods in-process and remote, so the menu bar, a REPL and the
 * CLI call one method set for every recorder kind. It goes through the recorder service while one runs and holds the
 * recording, else over the recording's own socket. `call` and `subscribe` stay for the raw protocol.
 */
export class RecorderClient extends RecorderControl {
    private readonly listeners = new Set<{
        onEvent: (notification: LiveNotification) => void;
        events?: ReadonlySet<string>;
    }>();
    private subscribed?: Promise<void>;

    readonly kind: string;
    readonly methods: readonly RecorderMethod[];

    private constructor(
        readonly entry: LiveEntry,
        private readonly transport: RecorderTransport
    ) {
        super();
        this.kind = entry.kind;
        this.methods = RECORDER_METHODS.filter((method) => entry.controls.includes(method));
        transport.onNotification((notification) => {
            for (const listener of this.listeners) {
                if (!listener.events || listener.events.has(notification.event)) {
                    listener.onEvent(notification);
                }
            }
        });
    }

    /** `service` while the calls go through the recorder service, `socket` on the recording's own socket. */
    get via(): RecorderTransport["via"] {
        return this.transport.via;
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

    /** Waits for the same post-processing as a stop before the folder goes to the trash, so the same deadline. */
    override discard(): Promise<StopAnswer> {
        return this.call("discard", undefined, STOP_TIMEOUT_MS);
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

    override addMarker(label: string): Promise<RecordingMarker> {
        return this.call("marker.add", { label });
    }

    override getSettings(): Promise<SettingsAnswer> {
        return this.call("settings.get");
    }

    override setSettings(patch: RecorderSettingsPatch): Promise<SettingsAnswer> {
        return this.call("settings.set", patch);
    }

    /**
     * Connects by id: through the recorder service when one runs and holds the recording, else over the recording's
     * socket. Throws when no such recording runs or its socket refuses (a stale entry counts as gone).
     */
    static async connect(id: string, options: { dir?: string; service?: ServiceJoin } = {}): Promise<RecorderClient> {
        const service = options.service ?? (options.dir ? false : { dir: recorderServiceDir() });
        const viaService = service ? await connectRecordingViaService(id, service.dir) : undefined;

        if (viaService) {
            return new RecorderClient(viaService.entry, viaService.transport);
        }

        const entry = readLiveRecording(id, options.dir);

        if (!entry) {
            throw new Error(`No running recording "${id}"`);
        }

        try {
            const rpc = await RpcSocketClient.connect({
                socket: entry.socket,
                logScope: "live-recordings",
                label: "live recording",
                closedMessage: "the recording closed the connection",
            });
            return new RecorderClient(entry, new SocketRecorderTransport(rpc));
        } catch (error) {
            log.debug({ error, id, socket: entry.socket }, "live recording socket refused");
            throw new Error(`No running recording "${id}" (its socket does not answer)`);
        }
    }

    /** One JSON-RPC call; an error reply rejects with an RpcError that carries its code. */
    /** A waiting `stop` gets the time a finish takes, through this path as through `stop()`. */
    call<T = unknown>(method: string, params?: unknown, timeoutMs = callTimeoutFor(method, params)): Promise<T> {
        return this.transport.call<T>(method, params, timeoutMs);
    }

    /** Receives notifications from now on: all of them, or only `events`. */
    async subscribe(onEvent: (notification: LiveNotification) => void, events?: LiveEvent[]): Promise<void> {
        this.listeners.add({ onEvent, ...(events ? { events: new Set(events) } : {}) });
        this.subscribed ??= this.transport.subscribe().catch((error: unknown) => {
            this.subscribed = undefined;
            throw error;
        });
        await this.subscribed;
    }

    close(): void {
        this.transport.close();
    }
}

/** Connects (through the recorder service while one runs), makes one call, and closes: what a CLI command needs. */
export async function callRecorder<T = unknown>(options: {
    id: string;
    method: string;
    params?: unknown;
    dir?: string;
    service?: ServiceJoin;
}): Promise<T> {
    const client = await RecorderClient.connect(options.id, {
        ...(options.dir ? { dir: options.dir } : {}),
        ...(options.service !== undefined ? { service: options.service } : {}),
    });

    try {
        return await client.call<T>(options.method, options.params);
    } finally {
        client.close();
    }
}
