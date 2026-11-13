import { withTimeout } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { type ChildStdioConnection, connectChildStdio } from "@genesiscz/utils/rpc/child-stdio";
import { RpcError } from "@genesiscz/utils/rpc/errors";
import type { RpcDialect, RpcPeer } from "@genesiscz/utils/rpc/peer";
import { resolveCodexBinary } from "./codex-binary";

const log = logger.child({ component: "openai:app-server-client" });

export type RpcId = number | string;

export interface RpcNotification {
    method: string;
    params?: unknown;
}

export interface RpcServerRequest extends RpcNotification {
    id: RpcId;
}

export interface AppServerProcess {
    pid: number;
    stdin: {
        write(value: string | Uint8Array): number | Promise<number>;
        flush?: () => number | Promise<number>;
        end(): number | undefined | Promise<number | undefined>;
    };
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
}

interface AppServerClientOptions {
    onNotification?: (notification: RpcNotification) => void | Promise<void>;
    onServerRequest?: (request: RpcServerRequest) => unknown | Promise<unknown>;
    onStderr?: (text: string) => void;
    onExit?: (code: number) => void | Promise<void>;
}

/**
 * What `codex app-server` speaks: JSON-RPC without the `jsonrpc` field, no `$/cancel` or `$/progress`, and its
 * requests answered as each handler settles, because an approval held for the lead must not hold a token refresh.
 * The deadline only bounds a request nobody answers: the TUI bridge forwards requests whose length this side cannot
 * know, and the callers that know theirs add a shorter one. A thread snapshot with its turns can pass the default
 * 8 MiB line, so the limit is higher.
 */
export const CODEX_APP_SERVER_DIALECT: Partial<RpcDialect> = {
    jsonrpcField: false,
    cancel: false,
    progress: false,
    defaultDeadlineMs: 30 * 60_000,
    inOrder: false,
    maxLineBytes: 256 * 1024 * 1024,
};

/** A JSON-RPC error response, with the `code` and `data` the server sent (`data.codexErrorInfo` names the cause). */
export class AppServerRpcError extends Error {
    constructor(
        message: string,
        readonly code?: number,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "AppServerRpcError";
    }
}

export class AppServerClient {
    /** The server requests whose answer is not on the wire yet, settled once it is (or failed to go). */
    private readonly answering = new Map<RpcId, Promise<void>>();
    private readonly options: AppServerClientOptions;
    private readonly connection: ChildStdioConnection;
    private readonly peer: RpcPeer;
    private closed = false;
    /** Serialises `onNotification` off the stdout reader; see `queueNotification`. */
    private notificationQueue: Promise<void> = Promise.resolve();

    constructor(
        readonly process: AppServerProcess,
        options: AppServerClientOptions = {}
    ) {
        this.options = options;
        this.connection = connectChildStdio({
            child: process,
            dialect: CODEX_APP_SERVER_DIALECT,
            exitReason: (code) => `Codex app-server exited with code ${code}`,
            invalid: "ignore",
            log: logger.scoped("codex-app-server").log,
            label: "Codex app-server",
            onNotification: (notification) => this.queueNotification(notification),
            handle: (incoming, context) => {
                if (typeof incoming.id !== "number" && typeof incoming.id !== "string") {
                    // A notification reaches `onNotification`; nothing without an id comes here.
                    return Promise.resolve(null);
                }

                const request = { id: incoming.id, method: incoming.method, params: incoming.params };
                this.trackAnswer(request.id, context.answered);
                return this.handleServerRequest(request);
            },
        });
        this.peer = this.connection.peer;
        void this.readStderr();
        void this.watchExit();
    }

    async request<T>(method: string, params?: unknown): Promise<T> {
        if (this.closed) {
            throw new Error("Codex app-server client is closed");
        }

        try {
            return await this.peer.request<T>(method, params);
        } catch (err) {
            if (err instanceof RpcError) {
                throw new AppServerRpcError(err.message, err.code, err.data);
            }

            throw err;
        }
    }

    async notify(method: string, params?: unknown): Promise<void> {
        this.peer.notify(method, params);
        await this.connection.written();
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.peer.close("Codex app-server client closed");

        try {
            // A sink whose reader is wedged never settles, and `close()` then never reaches the
            // kill below: the app-server outlives its launcher still holding that thread's writer
            // lock, so every later resume of it fails with "already has an active writer".
            await withTimeout(
                Promise.resolve(this.process.stdin.end()),
                1000,
                new Error("codex app-server stdin close")
            );
        } catch (err) {
            log.debug({ err }, "closing app-server stdin failed");
        }

        try {
            this.process.kill("SIGTERM");
        } catch (err) {
            log.debug({ err, pid: this.process.pid }, "terminating app-server failed");
            return;
        }

        // Reap it: an app-server that ignores SIGTERM outlives its launcher while still holding
        // a live ChatGPT token, and nothing else in the process tree will ever wait on it.
        try {
            await withTimeout(this.process.exited, 2000, new Error("codex app-server shutdown"));
        } catch (err) {
            log.debug({ err, pid: this.process.pid }, "app-server ignored SIGTERM; sending SIGKILL");
            try {
                this.process.kill("SIGKILL");
                await withTimeout(this.process.exited, 2000, new Error("codex app-server forced shutdown"));
            } catch (killErr) {
                log.warn({ err: killErr, pid: this.process.pid }, "Could not reap the Codex app-server");
            }
        }
    }

    private async readStderr(): Promise<void> {
        const reader = this.process.stderr.getReader();
        const decoder = new TextDecoder();

        try {
            for (;;) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }

                const text = decoder.decode(result.value, { stream: true });
                if (text) {
                    this.options.onStderr?.(text);
                }
            }

            const tail = decoder.decode();
            if (tail) {
                this.options.onStderr?.(tail);
            }
        } catch (err) {
            if (!this.closed) {
                log.warn({ err }, "reading app-server stderr failed");
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Notifications leave the reader loop here. Awaiting the handler inline made the
     * stdout reader wait on it, so a slow handler delayed every later response line and
     * a rejecting one tore down the loop and rejected every in-flight request. The chain
     * keeps the handlers in arrival order without the reader ever waiting for one.
     */
    private queueNotification(notification: RpcNotification): void {
        this.notificationQueue = this.notificationQueue.then(async () => {
            try {
                await this.options.onNotification?.(notification);
            } catch (err) {
                log.error({ err, method: notification.method }, "app-server notification handler failed");
            }
        });
    }

    /**
     * Resolves once this client's answer to the server request `id` has been written, and rejects with the write's
     * error when it failed: a caller that resolved the answer awaits it before its next message, so the server reads
     * the answer first, and a failed write must not read as an answer that arrived (eve on #648, 2026-11-01). An id
     * with no answer in flight resolves at once.
     */
    answered(id: RpcId): Promise<void> {
        return this.answering.get(id) ?? Promise.resolve();
    }

    /** `answered(id)` waits for the peer to send the answer, then for its write to reach stdin. */
    private trackAnswer(id: RpcId, sent: Promise<void>): void {
        const written = sent.then(() => this.connection.written());
        this.answering.set(id, written);
        written
            .catch(() => undefined)
            .finally(() => {
                if (this.answering.get(id) === written) {
                    this.answering.delete(id);
                }
            });
    }

    /**
     * A server request waits for the notifications that came before it (an approval reads the file changes they
     * announced), while the reader goes on settling replies. A thrown error answers with code -32000.
     */
    private async handleServerRequest(request: RpcServerRequest): Promise<unknown> {
        await this.notificationQueue;

        if (!this.options.onServerRequest) {
            throw new RpcError(-32_601, `No handler for server request ${request.method}`);
        }

        try {
            return await this.options.onServerRequest(request);
        } catch (err) {
            // The peer is told, and until now nothing else was: the text went out over the wire
            // and left no record of which handler threw.
            log.warn({ err, method: request.method }, "app-server request handler failed");
            throw new RpcError(-32_000, err instanceof Error ? err.message : String(err));
        }
    }

    private async watchExit(): Promise<void> {
        const code = await this.process.exited;
        const wasClosed = this.closed;
        this.closed = true;
        this.peer.close(`Codex app-server exited with code ${code}`);

        if (!wasClosed) {
            await this.options.onExit?.(code);
        }
    }
}

export interface SpawnAppServerOptions {
    cwd: string;
    home?: string;
    envOverrides?: Record<string, string>;
    /** Drop inherited credentials when a caller binds this process to an explicit account. */
    unsetEnv?: readonly string[];
    config?: string[];
}

/** The argv `spawnAppServer` runs, kept pure so a test can read it without starting codex. */
export function appServerCommand(binary: string, options: Pick<SpawnAppServerOptions, "config">): string[] {
    const cmd = [binary, "app-server"];

    for (const config of options.config ?? []) {
        cmd.push("-c", config);
    }

    return cmd;
}

export function spawnAppServer(options: SpawnAppServerOptions): AppServerProcess {
    const cmd = appServerCommand(resolveCodexBinary(), options);

    const childEnv = { ...env.getProcessEnv(), ...options.envOverrides };
    for (const key of options.unsetEnv ?? []) {
        delete childEnv[key];
    }
    if (options.home) {
        childEnv.CODEX_HOME = options.home;
    }

    const proc = Bun.spawn({
        cmd,
        cwd: options.cwd,
        env: childEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    return {
        pid: proc.pid,
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
        kill(signal) {
            proc.kill(signal);
        },
    };
}
