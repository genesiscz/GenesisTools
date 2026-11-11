import { SafeJSON } from "@genesiscz/utils/json";
import type { logger } from "@genesiscz/utils/logger";
import { currentToolName } from "@genesiscz/utils/security/vault-purpose";
import { z } from "zod";
import { JSON_RPC_ERRORS, RPC_CANCELLED, RpcError, rpcErrorBody } from "./errors";

/**
 * One side of a newline-delimited JSON-RPC 2.0 connection, the same on the server and on the client: it answers the
 * other side's requests, and sends requests of its own whose replies it matches by id. Each side numbers its own ids.
 * A message with a `method` is a request or a notification of the other side; one without is a reply. Two
 * notifications belong to the transport (the LSP shape): `$/progress { id, fraction?, label? }` from the side doing
 * the work, and `$/cancel { id }` from the side that asked. The dialect (`RpcDialect`) says which of these
 * conventions the other side speaks: the recorder speaks all of them, the Codex app-server writes no `jsonrpc` field.
 */

export type RpcId = string | number | null;
export type RpcLog = ReturnType<typeof logger.scoped>["log"];

export const PROGRESS_METHOD = "$/progress";
export const CANCEL_METHOD = "$/cancel";

/** The bytes one line may hold before the connection ends. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** What the other side of a connection speaks; every field has the recorder's value by default. */
export interface RpcDialect {
    /** Write `jsonrpc: "2.0"` on every message and require it on every message read. */
    jsonrpcField: boolean;
    /** Send `$/cancel` when a request's signal aborts, and stop a running call on the other side's `$/cancel`. */
    cancel: boolean;
    /** Send `$/progress` from a running call, and restart a request's deadline on the other side's `$/progress`. */
    progress: boolean;
    /** How long a request waits for its reply when the call names no `timeoutMs`. */
    defaultDeadlineMs: number;
    /**
     * Answer the other side's requests one after another, in the order they came. Off, each request is answered as
     * soon as its handler settles, so a request held for a person (an approval) does not hold the next one.
     */
    inOrder: boolean;
    /** The longest line read; a longer one ends the connection. */
    maxLineBytes: number;
}

/** The recorder's dialect, and the default of every field a peer does not set. */
export const DEFAULT_RPC_DIALECT: RpcDialect = {
    jsonrpcField: true,
    cancel: true,
    progress: true,
    defaultDeadlineMs: 10_000,
    inOrder: true,
    maxLineBytes: DEFAULT_MAX_LINE_BYTES,
};

export interface RpcProgress {
    fraction?: number;
    label?: string;
}

/** What a handler of the other side's call gets beside the params. */
export interface RpcCallContext {
    /** The caller's request id; undefined for a notification. */
    id?: RpcId;
    /** Aborts on the caller's `$/cancel` and when the connection closes. */
    signal: AbortSignal;
    /** Sends `$/progress` for this request (nothing for a notification, or a dialect without progress). */
    progress(update: RpcProgress): void;
    /**
     * Settles once this side's answer (its result or its error) went to the transport; rejects when the connection
     * had closed by then. A notification resolves once its handler settled.
     */
    answered: Promise<void>;
}

export interface RpcIncoming {
    id?: RpcId;
    method: string;
    params: unknown;
}

export interface RpcRequestOptions {
    timeoutMs?: number;
    /** Aborting rejects with an RpcError of code `RPC_CANCELLED`, and sends `$/cancel` when the dialect speaks it. */
    signal?: AbortSignal;
    onProgress?: (update: RpcProgress) => void;
}

const rpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const rpcRequest = z.object({
    id: rpcIdSchema.optional(),
    method: z.string(),
    params: z.unknown().optional(),
});
const rpcReply = z.object({
    id: rpcIdSchema.optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
/**
 * Without the `jsonrpc` field the other side speaks a JSON-RPC-like dialect (the Codex app-server), read as leniently
 * as its own client always read it: an error may come without a code or a message.
 */
const liteReply = rpcReply.extend({
    error: z
        .object({ code: z.number().optional(), message: z.string().optional(), data: z.unknown().optional() })
        .optional(),
});
const jsonrpcField = { jsonrpc: z.literal("2.0") };
const schemas = {
    withField: { request: rpcRequest.extend(jsonrpcField), reply: rpcReply.extend(jsonrpcField) },
    without: { request: rpcRequest, reply: liteReply },
};
const idParams = z.object({ id: z.union([z.string(), z.number()]) }).passthrough();
const progressParams = z.object({
    id: z.number(),
    fraction: z.number().min(0).max(1).optional(),
    label: z.string().optional(),
});

/** Splits a byte stream into lines; a partial line waits for its newline. */
export class LineBuffer {
    private pending = "";
    private pendingBytes = 0;
    private readonly decoder = new TextDecoder();

    constructor(private readonly maxBytes = DEFAULT_MAX_LINE_BYTES) {}

    push(chunk: Uint8Array): string[] {
        const parts = this.decoder.decode(chunk, { stream: true }).split("\n");
        const lines: string[] = [];

        for (const [index, part] of parts.entries()) {
            this.pendingBytes += Buffer.byteLength(part);

            if (this.pendingBytes > this.maxBytes) {
                this.pending = "";
                this.pendingBytes = 0;
                throw new Error(`RPC frame exceeds ${this.maxBytes / (1024 * 1024)} MiB`);
            }

            this.pending += part;

            if (index < parts.length - 1) {
                const line = this.pending.replace(/\r$/, "");
                this.pending = "";
                this.pendingBytes = 0;

                if (line.trim()) {
                    lines.push(line);
                }
            }
        }

        return lines;
    }
}

/** The unsent bytes one connection may hold. A reader that stopped reading reaches it, and its connection ends. */
export const OUTBOX_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Writes a whole message even when the socket takes only part of it now; the rest goes on `drain`. The queue is a
 * list of the unsent messages, so a slow reader costs no copy per message, and it holds at most `limit` bytes: the
 * message that would pass it calls `onFull` once, and the outbox drops it and every later one.
 */
export class Outbox {
    private readonly chunks: Buffer[] = [];
    private bytes = 0;
    private full = false;

    constructor(
        private readonly write: (bytes: Buffer) => number,
        private readonly onFull: (bytes: number) => void = () => undefined,
        private readonly limit = OUTBOX_LIMIT_BYTES
    ) {}

    /** The bytes still waiting for the socket. */
    get pending(): number {
        return this.bytes;
    }

    send(text: string): void {
        if (this.full) {
            return;
        }

        const message = Buffer.from(text);

        if (this.bytes > 0 && this.bytes + message.length > this.limit) {
            this.full = true;
            const held = this.bytes + message.length;
            this.chunks.length = 0;
            this.bytes = 0;
            this.onFull(held);
            return;
        }

        this.chunks.push(message);
        this.bytes += message.length;
        this.flush();
    }

    flush(): void {
        while (this.chunks.length > 0) {
            const head = this.chunks[0];
            const written = Math.max(0, this.write(head));
            this.bytes -= Math.min(written, head.length);

            if (written < head.length) {
                this.chunks[0] = head.subarray(written);
                return;
            }

            this.chunks.shift();
        }
    }
}

interface Outgoing {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    timeoutMs: number;
    onProgress?: (update: RpcProgress) => void;
    detach: () => void;
}

interface Running {
    controller: AbortController;
    /** `PromiseWithResolvers` by its shape: the dashboards that reach this file through the Codex client lack that lib name. */
    cancelled: ReturnType<typeof Promise.withResolvers<never>>;
}

export interface RpcPeerOptions {
    write: (bytes: Buffer) => number;
    /** Answers a request or a notification of the other side; a thrown RpcError goes back with its code. */
    handle: (incoming: RpcIncoming, context: RpcCallContext) => Promise<unknown>;
    /**
     * Hears the other side's notifications at once, outside the queue (a client); without it they are handled in
     * order with the requests, through `handle` (a server).
     */
    onNotification?: (notification: { method: string; params: unknown }) => void;
    /** A line that is no JSON-RPC message: a server answers `invalidRequest` (id null), a client only logs it. */
    invalid: "answer" | "ignore";
    log: RpcLog;
    /** Names the connection in log lines: `live recording` gives "live recording call refused". */
    label: string;
    /** The tool an error reply names in its `issue` (`meetings`); the tool this process runs when left out. */
    tool?: string;
    logFields?: Record<string, unknown>;
    /** What the other side speaks; a field left out keeps `DEFAULT_RPC_DIALECT`'s value. */
    dialect?: Partial<RpcDialect>;
    /** The other side stopped reading and its unsent messages reached `OUTBOX_LIMIT_BYTES`: end the socket here. */
    onBacklogFull?: () => void;
    /**
     * The lane of a method whose newer call replaces the older (a Moment's cut: the next row's click): a request in a
     * lane cancels every earlier request of the same lane that runs or waits, as a `$/cancel` would. Undefined: none.
     */
    supersedes?: (method: string) => string | undefined;
}

function parseOrNull(text: string, log: RpcLog, label: string): unknown {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        log.debug({ error }, `${label} text is not JSON`);
        return null;
    }
}

/** Stops a call that runs or waits: its signal aborts and it is answered with `RPC_CANCELLED`. */
function cancel(running: Running, message: string): void {
    const error = new RpcError(RPC_CANCELLED, message);
    running.controller.abort(error);
    running.cancelled.reject(error);
}

export class RpcPeer {
    private readonly lines: LineBuffer;
    private readonly outbox: Outbox;
    private readonly outgoing = new Map<number, Outgoing>();
    private readonly running = new Map<string | number, Running>();
    private readonly dialect: RpcDialect;
    private readonly schemas: (typeof schemas)[keyof typeof schemas];
    /** The requests of each supersede lane that run or wait, so a newer one cancels them. */
    private readonly lanes = new Map<string, Set<Running>>();
    private nextId = 1;
    private closedReason?: string;
    /** The other side's requests, answered one after another in the order they came (an in-order dialect). */
    queue: Promise<void> = Promise.resolve();

    constructor(private readonly options: RpcPeerOptions) {
        this.dialect = { ...DEFAULT_RPC_DIALECT, ...options.dialect };
        this.schemas = this.dialect.jsonrpcField ? schemas.withField : schemas.without;
        this.lines = new LineBuffer(this.dialect.maxLineBytes);
        this.outbox = new Outbox(options.write, (bytes) => {
            options.log.warn(
                { ...options.logFields, bytes },
                `${options.label} peer stopped reading its messages; the connection ends`
            );
            this.close("the other side stopped reading its messages");
            options.onBacklogFull?.();
        });
    }

    get closed(): boolean {
        return this.closedReason !== undefined;
    }

    /** Bytes from the socket. */
    receive(chunk: Uint8Array): void {
        if (this.closed) {
            return;
        }

        for (const line of this.lines.push(chunk)) {
            this.receiveLine(line);
        }
    }

    /** The socket can take more bytes. */
    flush(): void {
        this.outbox.flush();
    }

    send(body: Record<string, unknown>): void {
        const message = this.dialect.jsonrpcField ? { jsonrpc: "2.0", ...body } : body;
        this.outbox.send(`${SafeJSON.stringify(message)}\n`);
    }

    notify(method: string, params?: unknown): void {
        this.send({ method, ...(params !== undefined ? { params } : {}) });
    }

    /** A request to the other side; its reply resolves it, an error reply rejects with an RpcError of that code. */
    request<T = unknown>(method: string, params?: unknown, options: RpcRequestOptions = {}): Promise<T> {
        if (this.closedReason) {
            return Promise.reject(new Error(this.closedReason));
        }

        const id = this.nextId++;
        const timeoutMs = options.timeoutMs ?? this.dialect.defaultDeadlineMs;
        return new Promise<T>((resolve, reject) => {
            const signal = options.signal;
            const onAbort = () => {
                const waiting = this.outgoing.get(id);

                if (!waiting) {
                    return;
                }

                this.drop(id, waiting);

                if (this.dialect.cancel) {
                    this.notify(CANCEL_METHOD, { id });
                }

                reject(new RpcError(RPC_CANCELLED, `${method}: cancelled`));
            };
            const waiting: Outgoing = {
                method,
                resolve: (value) => resolve(value as T),
                reject,
                timer: this.deadline(id, method, timeoutMs),
                timeoutMs,
                onProgress: options.onProgress,
                detach: () => signal?.removeEventListener("abort", onAbort),
            };

            if (signal?.aborted) {
                clearTimeout(waiting.timer);
                reject(new RpcError(RPC_CANCELLED, `${method}: cancelled`));
                return;
            }

            signal?.addEventListener("abort", onAbort, { once: true });
            this.outgoing.set(id, waiting);
            this.send({ id, method, ...(params !== undefined ? { params } : {}) });
        });
    }

    /** The connection ended: every request still waiting rejects with `reason`, every running call's signal aborts. */
    close(reason: string): void {
        if (this.closedReason) {
            return;
        }

        this.closedReason = reason;

        for (const [id, waiting] of this.outgoing) {
            this.drop(id, waiting);
            waiting.reject(new Error(reason));
        }

        for (const running of this.running.values()) {
            const error = new RpcError(RPC_CANCELLED, reason);
            running.controller.abort(error);
            running.cancelled.reject(error);
        }
    }

    private deadline(id: number, method: string, timeoutMs: number): ReturnType<typeof setTimeout> {
        return setTimeout(() => {
            const waiting = this.outgoing.get(id);

            if (waiting) {
                this.drop(id, waiting);
                waiting.reject(new Error(`${method}: no answer within ${timeoutMs / 1000} s`));
            }
        }, timeoutMs);
    }

    private drop(id: number, waiting: Outgoing): void {
        clearTimeout(waiting.timer);
        waiting.detach();
        this.outgoing.delete(id);
    }

    private receiveLine(line: string): void {
        const value = parseOrNull(line, this.options.log, this.options.label);
        const request = this.schemas.request.safeParse(value);

        if (request.success) {
            const { id, method, params } = request.data;

            // The transport's own notifications act at once: the call they name may be running now.
            if (id === undefined && method === CANCEL_METHOD && this.dialect.cancel) {
                this.cancelRunning(params);
                return;
            }

            if (id === undefined && method === PROGRESS_METHOD && this.dialect.progress) {
                this.progressOutgoing(params);
                return;
            }

            if (id === undefined && this.options.onNotification) {
                this.options.onNotification({ method, params });
                return;
            }

            this.enqueue({ ...(id !== undefined ? { id } : {}), method, params });
            return;
        }

        const reply = this.schemas.reply.safeParse(value);

        const replyShaped = typeof value === "object" && value !== null && ("result" in value || "error" in value);

        if (reply.success && replyShaped && typeof reply.data.id === "number") {
            if (this.settle(reply.data.id, reply.data)) {
                return;
            }

            if (reply.data.id >= 1 && reply.data.id < this.nextId) {
                this.options.log.debug(
                    { ...this.options.logFields, id: reply.data.id },
                    `${this.options.label}: a reply came after its request gave up`
                );
                return;
            }
        }

        if (this.options.invalid === "ignore") {
            this.options.log.debug({ line }, `unreadable ${this.options.label} message`);
            return;
        }

        this.queue = this.queue.then(() =>
            this.send({
                id: null,
                error: { code: JSON_RPC_ERRORS.invalidRequest, message: "not a JSON-RPC 2.0 request" },
            })
        );
    }

    private settle(id: number, reply: z.infer<typeof liteReply>): boolean {
        const waiting = this.outgoing.get(id);

        if (!waiting) {
            return false;
        }

        this.drop(id, waiting);

        if (reply.error) {
            const { code = JSON_RPC_ERRORS.internal, message, data } = reply.error;
            waiting.reject(new RpcError(code, message ?? `${this.options.label} returned an unknown RPC error`, data));
        } else {
            waiting.resolve(reply.result);
        }

        return true;
    }

    private progressOutgoing(params: unknown): void {
        const parsed = progressParams.safeParse(params);
        const waiting = parsed.success ? this.outgoing.get(parsed.data.id) : undefined;

        if (!parsed.success || !waiting) {
            return;
        }

        // The other side is working on it: its deadline starts again.
        clearTimeout(waiting.timer);
        waiting.timer = this.deadline(parsed.data.id, waiting.method, waiting.timeoutMs);
        const { id: _id, ...update } = parsed.data;
        waiting.onProgress?.(update);
    }

    private cancelRunning(params: unknown): void {
        const parsed = idParams.safeParse(params);
        const running = parsed.success ? this.running.get(parsed.data.id) : undefined;

        if (!running) {
            return;
        }

        cancel(running, "cancelled");
    }

    private enqueue(incoming: RpcIncoming): void {
        const key = incoming.id === undefined || incoming.id === null ? undefined : incoming.id;
        const running: Running = { controller: new AbortController(), cancelled: Promise.withResolvers<never>() };
        // A cancel can come before the call's turn or after its answer; neither may surface as an unhandled rejection.
        running.cancelled.promise.catch(() => undefined);

        if (key !== undefined) {
            this.running.set(key, running);
        }

        // A newer call of a supersede lane cancels the older ones at once, before it waits for its own turn.
        const lane = key === undefined ? undefined : this.options.supersedes?.(incoming.method);
        const peers = lane === undefined ? undefined : (this.lanes.get(lane) ?? new Set<Running>());

        if (lane !== undefined && peers) {
            for (const older of peers) {
                cancel(older, `a newer ${incoming.method} replaced this call`);
            }

            peers.clear();
            peers.add(running);
            this.lanes.set(lane, peers);
        }

        const run = async () => {
            try {
                await this.answer(incoming, running);
            } finally {
                if (key !== undefined && this.running.get(key) === running) {
                    this.running.delete(key);
                }

                peers?.delete(running);
            }
        };

        if (this.dialect.inOrder) {
            this.queue = this.queue.then(run);
            return;
        }

        run().catch((error) => {
            this.options.log.warn({ ...this.options.logFields, error }, `${this.options.label} answer not sent`);
        });
    }

    private async answer(incoming: RpcIncoming, running: Running): Promise<void> {
        const { id, method } = incoming;
        const { label, log, logFields } = this.options;
        const answered = Promise.withResolvers<void>();
        // A handler that does not wait for its own answer must not surface a closed connection as unhandled.
        answered.promise.catch(() => undefined);
        const context: RpcCallContext = {
            ...(id !== undefined ? { id } : {}),
            signal: running.controller.signal,
            progress: (update) => {
                if (id !== undefined && id !== null && !this.closed && this.dialect.progress) {
                    this.notify(PROGRESS_METHOD, { id, ...update });
                }
            },
            answered: answered.promise,
        };
        const reply = (body: Record<string, unknown>) => {
            if (id !== undefined) {
                this.send({ id, ...body });
            }

            if (this.closedReason) {
                answered.reject(new Error(this.closedReason));
            } else {
                answered.resolve();
            }
        };

        try {
            if (this.closed || running.controller.signal.aborted) {
                throw running.controller.signal.reason;
            }

            const work = this.options.handle(incoming, context);
            // A handler that goes on after a cancel must not surface as an unhandled rejection.
            work.catch(() => undefined);
            const result = await Promise.race([work, running.cancelled.promise]);
            log.debug({ ...logFields, method }, `${label} call`);
            reply({ result: result ?? null });
        } catch (error) {
            // A refusal (an RpcError) is the caller's answer, which it gets; only an unexpected throw is this side's.
            if (error instanceof RpcError) {
                log.debug({ ...logFields, method, error }, `${label} call refused`);
            } else {
                log.warn({ ...logFields, method, error }, `${label} call failed`);
            }

            reply({ error: rpcErrorBody(error, this.options.tool ?? currentToolName()) });
        }
    }
}
