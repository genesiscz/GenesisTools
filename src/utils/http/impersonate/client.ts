import type { Pointer } from "bun:ffi";
import { untilAborted, withTimeout } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { openLibcurl } from "./libcurl";
import { ensureLibcurlImpersonate } from "./library";
import type { FromWorker, ToWorker, WorkerReply } from "./protocol";

/**
 * HTTP with a real Chrome TLS/HTTP2/header fingerprint, for sites behind Cloudflare Bot Management that answer
 * Bun's fetch with a 403 challenge page (Alza: measured 2026-11-01, plain fetch, every `impit` profile and wreq-js
 * 403, curl_cffi 200). It loads libcurl-impersonate, the library curl_cffi wraps, through bun:ffi in a worker
 * thread (`worker.ts`), with the browser targets curl_cffi 0.17 picks, so the wire fingerprint is curl_cffi's own.
 * The first request downloads the pinned library (`library.ts`); nothing else has to be installed.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
/** curl enforces `timeoutMs`; this margin covers the worker start and the reply message. */
const REPLY_MARGIN_MS = 15_000;
/** How long close() waits for the worker to release its curl handles before it terminates it anyway. */
const CLOSE_GRACE_MS = 2_000;
/** How long a new worker may take to open the library and answer `ready` (the download has its own deadline). */
const WORKER_READY_MS = 15_000;

export type ImpersonateProfile = "chrome" | "safari" | "firefox" | "edge";

/** curl_cffi 0.17's DEFAULT_CHROME / DEFAULT_SAFARI / DEFAULT_FIREFOX / DEFAULT_EDGE. */
const PROFILE_TARGETS: Record<ImpersonateProfile, string> = {
    chrome: "chrome152",
    safari: "safari270",
    firefox: "firefox155",
    edge: "edge101",
};

export interface ImpersonatedRequest {
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    followRedirects?: boolean;
    /** Rejects the wait when it aborts, and cancels the transfer. An abort while the worker starts sends nothing. */
    signal?: AbortSignal;
    /** Stops the transfer and rejects once the body passes this many bytes, so a large answer is never buffered. */
    maxBodyBytes?: number;
    /** Sends no cookie from this client's jar and keeps none from the answer, for a check that must leave no trace. */
    noCookies?: boolean;
}

export interface ImpersonatedResponse {
    status: number;
    /** The final URL after redirects. */
    url: string;
    headers: Record<string, string>;
    text: string;
}

export interface ImpersonatedHttpClientOptions {
    profile?: ImpersonateProfile;
    /** http(s) or socks5 proxy for every request of this client. */
    proxyUrl?: string;
    /** Names the client in log lines. */
    label?: string;
    /**
     * Ends the worker after this many ms with no request in flight; the next request starts a new one (with an
     * empty cookie jar). For a long-lived server, so an idle server holds no curl connections.
     */
    idleCloseMs?: number;
}

interface Pending {
    resolve: (reply: WorkerReply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    /** The worker carrying the request: its close or crash ends this request, never one of a newer worker. */
    worker: ImpersonateEngine["worker"];
}

/** A started curl worker. `start()` makes the real one; a test may return another. */
export interface ImpersonateEngine {
    worker: Pick<Worker, "postMessage" | "terminate">;
    wakeup: () => void;
    closed: Promise<void>;
}

export class ImpersonatedHttpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImpersonatedHttpError";
    }
}

/** The body passed the request's `maxBodyBytes`; the worker stopped the transfer before buffering the rest. */
export class ImpersonatedBodyTooLargeError extends ImpersonatedHttpError {
    constructor(
        message: string,
        readonly maxBodyBytes: number
    ) {
        super(message);
        this.name = "ImpersonatedBodyTooLargeError";
    }
}

function abortedError(method: string, url: string): ImpersonatedHttpError {
    return new ImpersonatedHttpError(`${method} ${url}: aborted`);
}

export class ImpersonatedHttpClient {
    private engine: Promise<ImpersonateEngine> | null = null;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly profile: ImpersonateProfile;
    private readonly label: string;

    constructor(private readonly options: ImpersonatedHttpClientOptions = {}) {
        this.profile = options.profile ?? "chrome";
        this.label = options.label ?? "impersonate";
    }

    async request(req: ImpersonatedRequest): Promise<ImpersonatedResponse> {
        const method = req.method ?? "GET";
        if (req.signal?.aborted) {
            throw abortedError(method, req.url);
        }

        this.cancelIdleClose();
        const id = this.nextId++;
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const started = performance.now();
        let reply: WorkerReply;
        try {
            const engine = await this.engineFor(req, method);
            reply = await new Promise<WorkerReply>((resolve, reject) => {
                const onAbort = () => {
                    const waiter = this.pending.get(id);
                    if (!waiter) {
                        return;
                    }

                    clearTimeout(waiter.timer);
                    this.pending.delete(id);
                    this.send(engine, { type: "abort", id });
                    reject(abortedError(method, req.url));
                };
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    req.signal?.removeEventListener("abort", onAbort);
                    this.send(engine, { type: "abort", id });
                    reject(new ImpersonatedHttpError(`${method} ${req.url}: no reply in ${timeoutMs} ms`));
                }, timeoutMs + REPLY_MARGIN_MS);
                this.pending.set(id, {
                    resolve: (value) => {
                        req.signal?.removeEventListener("abort", onAbort);
                        resolve(value);
                    },
                    reject: (error) => {
                        req.signal?.removeEventListener("abort", onAbort);
                        reject(error);
                    },
                    timer,
                    worker: engine.worker,
                });
                req.signal?.addEventListener("abort", onAbort, { once: true });
                this.send(engine, {
                    type: "request",
                    id,
                    url: req.url,
                    method,
                    headers: req.headers ?? {},
                    body: req.body,
                    timeoutMs,
                    followRedirects: req.followRedirects ?? true,
                    maxBodyBytes: req.maxBodyBytes,
                    noCookies: req.noCookies,
                });
            });
        } finally {
            this.scheduleIdleClose();
        }

        const ms = Math.round(performance.now() - started);
        if (reply.error) {
            logger.debug({ label: this.label, url: req.url, ms, error: reply.error }, "impersonated request failed");
            if (reply.overLimit && req.maxBodyBytes !== undefined) {
                throw new ImpersonatedBodyTooLargeError(`${method} ${req.url}: ${reply.error}`, req.maxBodyBytes);
            }

            throw new ImpersonatedHttpError(`${method} ${req.url}: ${reply.error}`);
        }

        logger.debug({ label: this.label, method, url: req.url, status: reply.status, ms }, "impersonated request");
        return {
            status: reply.status,
            url: reply.url,
            headers: reply.headers,
            text: Buffer.from(reply.body).toString("utf8"),
        };
    }

    /** Ends the worker and its connections. Pending requests are rejected. */
    async close(): Promise<void> {
        this.cancelIdleClose();
        const starting = this.engine;
        if (!starting) {
            return;
        }

        this.engine = null;
        let engine: ImpersonateEngine;
        try {
            engine = await starting;
        } catch (error) {
            logger.debug({ error, label: this.label }, "impersonate worker never started, nothing to close");
            return;
        }

        // Only this worker's requests: a request after close() already runs on a new worker.
        this.rejectAll(engine.worker, "impersonate client closed");
        engine.worker.postMessage({ type: "close" } satisfies ToWorker);
        // A cleared timer, not Bun.sleep: a pending sleep keeps the process alive for its full grace after the exit.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const released = await Promise.race([
            engine.closed.then(() => true),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
            }),
        ]);
        clearTimeout(timer);
        if (!released) {
            logger.debug({ label: this.label }, "impersonate worker did not confirm close, terminating it");
        }

        engine.worker.terminate();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private send(engine: ImpersonateEngine, message: ToWorker): void {
        engine.worker.postMessage(message);
        engine.wakeup();
    }

    private cancelIdleClose(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private scheduleIdleClose(): void {
        const idleMs = this.options.idleCloseMs;
        if (idleMs === undefined || this.pending.size > 0 || !this.engine) {
            return;
        }

        this.cancelIdleClose();
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            logger.debug({ label: this.label, idleMs }, "impersonate worker idle, closing it");
            void this.close();
        }, idleMs);
        this.idleTimer.unref?.();
    }

    /**
     * The running worker. The first request may wait for the library download and the worker start; an abort in that
     * wait rejects at once, and a request whose signal aborted meanwhile is never posted. A worker that close() gave
     * up on while it started is refused: it is being closed, so a request posted to it would never be answered.
     */
    private async engineFor(req: ImpersonatedRequest, method: string): Promise<ImpersonateEngine> {
        const starting = this.ensureStarted();
        let engine: ImpersonateEngine;
        try {
            engine = await untilAborted(starting, req.signal);
        } catch (error) {
            if (req.signal?.aborted) {
                throw abortedError(method, req.url);
            }

            throw error;
        }

        if (req.signal?.aborted) {
            throw abortedError(method, req.url);
        }

        if (this.engine !== starting) {
            throw new ImpersonatedHttpError(`${method} ${req.url}: impersonate client closed`);
        }

        return engine;
    }

    /** Each start clears `this.engine` only while it is still the current one, never a newer worker's start. */
    private ensureStarted(): Promise<ImpersonateEngine> {
        if (!this.engine) {
            const forget = () => {
                if (this.engine === starting) {
                    this.engine = null;
                }
            };
            const starting: Promise<ImpersonateEngine> = this.start(forget).catch((error: unknown) => {
                forget();
                throw error;
            });
            this.engine = starting;
        }

        return this.engine;
    }

    /** Starts a worker. `forget` drops it as the current worker (after a crash) unless a newer one replaced it. */
    protected async start(forget: () => void): Promise<ImpersonateEngine> {
        const files = await ensureLibcurlImpersonate();
        const target = PROFILE_TARGETS[this.profile];
        logger.debug({ label: this.label, library: files.library, target }, "starting impersonate worker");
        const worker = new Worker(new URL("./worker.ts", import.meta.url));
        // Requests in flight hold their reply timers, so an idle worker need not keep the process alive. Bun's
        // Worker has unref(); the DOM Worker type the compiler sees does not.
        if ("unref" in worker && typeof worker.unref === "function") {
            worker.unref();
        }

        let markClosed: () => void = () => {};
        const closed = new Promise<void>((resolve) => {
            markClosed = resolve;
        });
        const ready = new Promise<number>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<FromWorker>) => {
                const message = event.data;
                switch (message.type) {
                    case "ready":
                        resolve(message.multi);
                        return;
                    case "failed":
                        reject(new ImpersonatedHttpError(`impersonate worker failed: ${message.error}`));
                        return;
                    case "reply":
                        this.deliver(message);
                        return;
                    case "closed":
                        markClosed();
                        return;
                }
            };
            worker.onerror = (event: ErrorEvent) => {
                const error = new ImpersonatedHttpError(`impersonate worker crashed: ${event.message}`);
                logger.warn(
                    { label: this.label, error: event.message, pending: this.pending.size },
                    "impersonate worker crashed"
                );
                forget();
                this.rejectAll(worker, error.message);
                reject(error);
            };
            worker.postMessage({
                type: "init",
                library: files.library,
                caBundle: files.caBundle,
                target,
                proxyUrl: this.options.proxyUrl,
            } satisfies ToWorker);
        });
        let multi: number;
        try {
            multi = await withTimeout(
                ready,
                WORKER_READY_MS,
                new ImpersonatedHttpError(`impersonate worker did not start within ${WORKER_READY_MS} ms`)
            );
        } catch (error) {
            worker.terminate();
            throw error;
        }

        const curl = openLibcurl(files.library);
        const multiHandle = multi as Pointer;
        return { worker, closed, wakeup: () => void curl.multiWakeup(multiHandle) };
    }

    private deliver(reply: WorkerReply): void {
        const waiter = this.pending.get(reply.id);
        if (!waiter) {
            logger.debug({ label: this.label, id: reply.id }, "impersonate reply for a request that already ended");
            return;
        }

        clearTimeout(waiter.timer);
        this.pending.delete(reply.id);
        waiter.resolve(reply);
    }

    private rejectAll(worker: ImpersonateEngine["worker"], reason: string): void {
        for (const [id, waiter] of this.pending) {
            if (waiter.worker !== worker) {
                continue;
            }

            clearTimeout(waiter.timer);
            waiter.reject(new ImpersonatedHttpError(reason));
            this.pending.delete(id);
        }
    }
}
