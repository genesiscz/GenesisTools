import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type WatcherSubscription, watchPath } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { RpcError } from "@genesiscz/utils/rpc/errors";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { z } from "zod";
import { RPC_ERRORS } from "./control";
import { recordingsLibraryDir } from "./library";
import {
    type LiveEntry,
    type LiveEntryChange,
    type LiveNotification,
    liveEntrySchema,
    type RecorderTransport,
} from "./live";

/**
 * The live recordings' side of the recorder service (`tools recorder serve`, src/recorder/lib/service.ts): where it
 * runs, a recording's registration with it, and a client's way to a recording through it. This package cannot import
 * the recorder tool, so the discovery the service writes lives here and the service's protocol module re-exports it.
 */

const { log } = logger.scoped("live-recordings");

export const SERVICE_PROTOCOL = 1;

/** `host` answers window, render and camera calls; `client` calls; `recording` is a live recording's process. */
export const ROLES = ["host", "client", "recording"] as const;
export type ServiceRole = (typeof ROLES)[number];

/** The recording's notification to the service, which passes it on to subscribers with the recording's id. */
export const RECORDING_EVENT = "recording.event";
/** The service's notification when a recording registers, changes or goes. */
export const RECORDINGS_CHANGED = "recordings.changed";

/** `<genesis-tools root>/recordings`: the library's parent, where `service.json` and the socket live. */
export function recorderServiceDir(): string {
    return dirname(recordingsLibraryDir());
}

export function serviceEntryPath(dir: string): string {
    return join(dir, "service.json");
}

/** `service.json`: where the running service listens. */
export const serviceEntrySchema = z.object({
    version: z.literal(1),
    protocol: z.number().int(),
    pid: z.number().int().positive(),
    /** The service's command line when it wrote the entry, so a recycled pid reads as gone. */
    pidCommand: z.string().optional(),
    socket: z.string(),
    startedAt: z.string(),
    /** When the service started, in ms; a module of the repo changed after it makes the service exit. */
    codeStamp: z.number(),
});
export type ServiceEntry = z.infer<typeof serviceEntrySchema>;

/** The running service named in `service.json`, or undefined when there is none or its process is gone. */
export function readLiveService(dir = recorderServiceDir()): ServiceEntry | undefined {
    const path = serviceEntryPath(dir);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const entry = serviceEntrySchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        const status = classifyPid(entry.pid, entry.pidCommand).status;
        return status === "live" || status === "unverified" ? entry : undefined;
    } catch (error) {
        log.debug({ error, path }, "service.json does not read; no service");
        return undefined;
    }
}

/** Connects to the service and says hello in a role; the caller closes the client. */
export async function connectService(options: {
    entry: ServiceEntry;
    role: ServiceRole;
    onRequest?: (method: string, params: unknown) => Promise<unknown>;
}): Promise<RpcSocketClient> {
    const onRequest = options.onRequest;
    const client = await RpcSocketClient.connect({
        socket: options.entry.socket,
        logScope: "live-recordings",
        label: "recorder service",
        ...(onRequest ? { onRequest: (incoming) => onRequest(incoming.method, incoming.params) } : {}),
    });

    try {
        await client.call("hello", { role: options.role, protocol: SERVICE_PROTOCOL, pid: process.pid });
        return client;
    } catch (error) {
        client.close();
        throw error;
    }
}

/**
 * The service a live recording joins: `dir` names the folder of its `service.json`, `pollMs` the safety poll behind
 * the watch on it (tests shorten it); false joins none.
 */
export type ServiceJoin = { dir: string; pollMs?: number } | false;

/** How long a refused join waits before it tries the same service again; a new service is tried at once. */
const RETRY_SAME_SERVICE_MS = 10_000;
/** The safety poll behind the watch on `service.json` (bun's fs.watch can go deaf after a close in the process). */
const JOIN_POLL_MS = 3_000;
/** A change of only the frame counts reaches the service at most this often. */
const FRAME_UPDATE_MS = 2_000;

function serviceKey(entry: ServiceEntry): string {
    return `${entry.pid}:${entry.startedAt}`;
}

/**
 * A live recording's membership in the recorder service. While a service runs, the recording is connected to it as a
 * `recording` and registered (`recordings.register` with its entry); the service forwards its clients' calls to it
 * as requests on that connection and passes its changes and events on. When the service goes the recording goes on
 * recording on its own socket; a watch on `service.json` joins the next service that starts.
 */
export class ServiceRegistration {
    private client?: RpcSocketClient;
    private watch?: WatcherSubscription;
    private poll?: ReturnType<typeof setInterval>;
    private joining?: Promise<void>;
    private refused?: { key: string; until: number };
    private frameTimer?: ReturnType<typeof setTimeout>;
    private closed = false;

    constructor(
        private readonly options: {
            dir: string;
            /** The entry as it is now; registered on every join and sent on every change. */
            entry: () => LiveEntry;
            /** Answers a control method the service forwards (`RECORDER_DISPATCH` on the recording's control). */
            answer: (method: string, params: unknown) => Promise<unknown>;
            pollMs?: number;
        }
    ) {}

    /** Watches for a service and joins the one that runs now. */
    start(): void {
        const { dir } = this.options;

        try {
            mkdirSync(dir, { recursive: true });
            this.watch = watchPath(serviceEntryPath(dir), () => this.join());
        } catch (error) {
            log.warn({ error, dir }, "cannot watch for the recorder service; the safety poll finds it");
        }

        this.poll = setInterval(() => this.join(), this.options.pollMs ?? JOIN_POLL_MS);
        this.poll.unref?.();
        void this.join();
    }

    /** True while the recording is registered with a service. */
    get joined(): boolean {
        return this.client !== undefined && !this.client.closed;
    }

    /** Resolves once a join that is under way ended (tests). */
    async settled(): Promise<void> {
        await this.joining;
    }

    /** Sends the entry after a change; a change of only the frame counts waits a little and goes with the next one. */
    changed(change: LiveEntryChange): void {
        const framesOnly = Object.keys(change).every((key) => key === "frames" || key === "lastFrameAt");

        if (framesOnly) {
            this.frameTimer ??= setTimeout(() => {
                this.frameTimer = undefined;
                this.send();
            }, FRAME_UPDATE_MS);
            this.frameTimer.unref?.();
            return;
        }

        this.send();
    }

    /** Passes a live recording event to the service. */
    event(event: string, params: Record<string, unknown>): void {
        if (this.joined) {
            this.client?.notify(RECORDING_EVENT, { event, params });
        }
    }

    /** Leaves the service; the service tells its subscribers the recording ended. */
    close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        clearInterval(this.poll);
        clearTimeout(this.frameTimer);
        void this.watch?.unsubscribe();
        const client = this.client;
        this.client = undefined;
        client?.close();
    }

    private send(): void {
        clearTimeout(this.frameTimer);
        this.frameTimer = undefined;

        if (this.joined) {
            this.client?.notify("recordings.register", this.options.entry());
        }
    }

    private join(): Promise<void> {
        if (this.closed || this.joined) {
            return Promise.resolve();
        }

        this.joining ??= this.tryJoin().finally(() => {
            this.joining = undefined;
        });
        return this.joining;
    }

    private async tryJoin(): Promise<void> {
        const service = readLiveService(this.options.dir);

        if (!service) {
            return;
        }

        const key = serviceKey(service);

        if (this.refused?.key === key && Date.now() < this.refused.until) {
            return;
        }

        const id = this.options.entry().id;
        let client: RpcSocketClient | undefined;

        try {
            client = await connectService({ entry: service, role: "recording", onRequest: this.options.answer });
            await client.call("recordings.register", this.options.entry());
        } catch (error) {
            client?.close();
            // Another protocol never changes for this service; anything else is tried again after a while.
            const until =
                error instanceof RpcError && error.code === RPC_ERRORS.protocolMismatch
                    ? Number.POSITIVE_INFINITY
                    : Date.now() + RETRY_SAME_SERVICE_MS;
            this.refused = { key, until };
            log.debug({ error, id, service: service.pid }, "the recorder service did not take the recording");
            return;
        }

        if (this.closed) {
            client.close();
            return;
        }

        const joined = client;
        this.client = joined;
        this.refused = undefined;
        joined.onClose((reason) => {
            if (this.client !== joined) {
                return;
            }

            this.client = undefined;
            log.info({ id, reason }, "the recorder service went; the recording goes on and waits for the next one");
            void this.join();
        });
        log.info({ id, service: service.pid }, "live recording joined the recorder service");
    }
}

const recordingEventSchema = z.object({ id: z.string(), event: z.string(), params: z.unknown().optional() });
const liveAnswerSchema = z.object({ recordings: z.array(z.object({ id: z.string() }).passthrough()) });

/** How much longer a client waits than the service waits for the recording, so the service's answer comes first. */
const FORWARD_MARGIN_MS = 2_000;

/** One recording's control methods through the service: `recording.call` with its id, its events from `recording.event`. */
export class ServiceRecorderTransport implements RecorderTransport {
    readonly via = "service";
    private readonly listeners = new Set<(notification: LiveNotification) => void>();

    constructor(
        private readonly id: string,
        private readonly client: RpcSocketClient
    ) {
        client.onNotification(({ method, params }) => {
            const parsed = method === RECORDING_EVENT ? recordingEventSchema.safeParse(params) : undefined;

            if (!parsed?.success || parsed.data.id !== id) {
                return;
            }

            for (const listener of this.listeners) {
                listener({ event: parsed.data.event, params: parsed.data.params ?? {} });
            }
        });
    }

    call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
        return this.client.call<T>(
            "recording.call",
            { id: this.id, method, ...(params === undefined ? {} : { params }) },
            { timeoutMs: timeoutMs + FORWARD_MARGIN_MS }
        );
    }

    onNotification(listener: (notification: LiveNotification) => void): void {
        this.listeners.add(listener);
    }

    async subscribe(): Promise<void> {
        await this.client.call("subscribe", { events: [RECORDING_EVENT] });
    }

    close(): void {
        this.client.close();
    }
}

/**
 * A recording through the running service: its entry as the service holds it and a transport over the service, or
 * undefined when no service runs, it does not answer, or the recording is not registered with it (the caller then
 * uses the recording's own socket).
 */
export async function connectRecordingViaService(
    id: string,
    dir: string
): Promise<{ entry: LiveEntry; transport: ServiceRecorderTransport } | undefined> {
    const service = readLiveService(dir);

    if (!service) {
        return undefined;
    }

    let client: RpcSocketClient | undefined;

    try {
        client = await connectService({ entry: service, role: "client" });
        const answer = liveAnswerSchema.parse(await client.call("recordings.live", {}));
        const row = answer.recordings.find((recording) => recording.id === id);

        if (!row) {
            log.debug({ id }, "the recorder service holds no such recording; using its own socket");
            client.close();
            return undefined;
        }

        return { entry: liveEntrySchema.parse(row), transport: new ServiceRecorderTransport(id, client) };
    } catch (error) {
        log.debug(
            { error, id, service: service.pid },
            "the recorder service did not answer; using the recording's socket"
        );
        client?.close();
        return undefined;
    }
}
