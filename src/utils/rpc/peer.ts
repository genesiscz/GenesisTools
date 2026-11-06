import { SafeJSON } from "@genesiscz/utils/json";
import type { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { JSON_RPC_ERRORS, RPC_CANCELLED, RpcError } from "./errors";

/**
 * One side of a newline-delimited JSON-RPC 2.0 connection, the same on the server and on the client: it answers the
 * other side's requests one after another, in the order they came, and sends requests of its own whose replies it
 * matches by id. Each side numbers its own ids. Two notifications belong to the transport (the LSP shape):
 * `$/progress { id, fraction?, label? }` from the side doing the work, and `$/cancel { id }` from the side that asked.
 */

export type RpcId = string | number | null;
export type RpcLog = ReturnType<typeof logger.scoped>["log"];

export const PROGRESS_METHOD = "$/progress";
export const CANCEL_METHOD = "$/cancel";
const DEFAULT_TIMEOUT_MS = 10_000;

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
    /** Sends `$/progress` for this request (nothing for a notification); each one restarts the caller's deadline. */
    progress(update: RpcProgress): void;
}

export interface RpcIncoming {
    id?: RpcId;
    method: string;
    params: unknown;
}

export interface RpcRequestOptions {
    timeoutMs?: number;
    /** Aborting sends `$/cancel` and rejects with an RpcError of code `RPC_CANCELLED`. */
    signal?: AbortSignal;
    onProgress?: (update: RpcProgress) => void;
}

const rpcRequest = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
});
const rpcReply = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
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

    push(chunk: Uint8Array): string[] {
        const parts = this.decoder.decode(chunk, { stream: true }).split("\n");
        const lines: string[] = [];

        for (const [index, part] of parts.entries()) {
            this.pendingBytes += Buffer.byteLength(part);

            if (this.pendingBytes > 8 * 1024 * 1024) {
                this.pending = "";
                this.pendingBytes = 0;
                throw new Error("RPC frame exceeds 8 MiB");
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
    cancelled: PromiseWithResolvers<never>;
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
    logFields?: Record<string, unknown>;
    defaultTimeoutMs?: number;
    /** The other side stopped reading and its unsent messages reached `OUTBOX_LIMIT_BYTES`: end the socket here. */
    onBacklogFull?: () => void;
}

function parseOrNull(text: string, log: RpcLog, label: string): unknown {
    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        log.debug({ error }, `${label} text is not JSON`);
        return null;
    }
}

export class RpcPeer {
    private readonly lines = new LineBuffer();
    private readonly outbox: Outbox;
    private readonly outgoing = new Map<number, Outgoing>();
    private readonly running = new Map<string | number, Running>();
    private nextId = 1;
    private closedReason?: string;
    /** The other side's requests, answered one after another in the order they came. */
    queue: Promise<void> = Promise.resolve();

    constructor(private readonly options: RpcPeerOptions) {
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
        this.outbox.send(`${SafeJSON.stringify({ jsonrpc: "2.0", ...body })}\n`);
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
        const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        return new Promise<T>((resolve, reject) => {
            const signal = options.signal;
            const onAbort = () => {
                const waiting = this.outgoing.get(id);

                if (!waiting) {
                    return;
                }

                this.drop(id, waiting);
                this.notify(CANCEL_METHOD, { id });
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
        const request = rpcRequest.safeParse(value);

        if (request.success) {
            const { id, method, params } = request.data;

            // The transport's own notifications act at once: the call they name may be running now.
            if (id === undefined && method === CANCEL_METHOD) {
                this.cancelRunning(params);
                return;
            }

            if (id === undefined && method === PROGRESS_METHOD) {
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

        const reply = rpcReply.safeParse(value);

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

    private settle(id: number, reply: z.infer<typeof rpcReply>): boolean {
        const waiting = this.outgoing.get(id);

        if (!waiting) {
            return false;
        }

        this.drop(id, waiting);

        if (reply.error) {
            waiting.reject(new RpcError(reply.error.code, reply.error.message, reply.error.data));
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

        const error = new RpcError(RPC_CANCELLED, "cancelled");
        running.controller.abort(error);
        running.cancelled.reject(error);
    }

    private enqueue(incoming: RpcIncoming): void {
        const key = incoming.id === undefined || incoming.id === null ? undefined : incoming.id;
        const running: Running = { controller: new AbortController(), cancelled: Promise.withResolvers<never>() };
        // A cancel can come before the call's turn or after its answer; neither may surface as an unhandled rejection.
        running.cancelled.promise.catch(() => undefined);

        if (key !== undefined) {
            this.running.set(key, running);
        }

        this.queue = this.queue.then(async () => {
            try {
                await this.answer(incoming, running);
            } finally {
                if (key !== undefined && this.running.get(key) === running) {
                    this.running.delete(key);
                }
            }
        });
    }

    private async answer(incoming: RpcIncoming, running: Running): Promise<void> {
        const { id, method } = incoming;
        const { label, log, logFields } = this.options;
        const context: RpcCallContext = {
            ...(id !== undefined ? { id } : {}),
            signal: running.controller.signal,
            progress: (update) => {
                if (id !== undefined && id !== null && !this.closed) {
                    this.notify(PROGRESS_METHOD, { id, ...update });
                }
            },
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

            if (id !== undefined) {
                this.send({ id, result: result ?? null });
            }
        } catch (error) {
            const code = error instanceof RpcError ? error.code : JSON_RPC_ERRORS.internal;
            // A refusal (an RpcError) is the caller's answer, which it gets; only an unexpected throw is this side's.
            if (error instanceof RpcError) {
                log.debug({ ...logFields, method, error }, `${label} call refused`);
            } else {
                log.warn({ ...logFields, method, error }, `${label} call failed`);
            }

            if (id !== undefined) {
                const data = error instanceof RpcError ? error.data : undefined;
                this.send({
                    id,
                    error: {
                        code,
                        message: error instanceof Error ? error.message : String(error),
                        ...(data !== undefined ? { data } : {}),
                    },
                });
            }
        }
    }
}
