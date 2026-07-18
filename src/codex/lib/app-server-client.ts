import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "codex:app-server-client" });

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

interface PendingRequest {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(value: unknown): Error {
    if (isRecord(value) && typeof value.message === "string") {
        return new Error(value.message);
    }

    return new Error("Codex app-server returned an unknown RPC error");
}

export class AppServerClient {
    private readonly pending = new Map<RpcId, PendingRequest>();
    private readonly options: AppServerClientOptions;
    private nextId = 1;
    private closed = false;

    constructor(
        readonly process: AppServerProcess,
        options: AppServerClientOptions = {}
    ) {
        this.options = options;
        void this.readStdout();
        void this.readStderr();
        void this.watchExit();
    }

    async request<T>(method: string, params?: unknown): Promise<T> {
        if (this.closed) {
            throw new Error("Codex app-server client is closed");
        }

        const id = this.nextId;
        this.nextId += 1;

        const result = new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                method,
                resolve: (value) => resolve(value as T),
                reject,
            });
        });

        try {
            await this.writeMessage({ id, method, ...(params === undefined ? {} : { params }) });
        } catch (err) {
            this.pending.delete(id);
            throw err;
        }

        return result;
    }

    async notify(method: string, params?: unknown): Promise<void> {
        await this.writeMessage({ method, ...(params === undefined ? {} : { params }) });
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.rejectPending(new Error("Codex app-server client closed"));

        try {
            await this.process.stdin.end();
        } catch (err) {
            log.debug({ err }, "closing app-server stdin failed");
        }

        try {
            this.process.kill("SIGTERM");
        } catch (err) {
            log.debug({ err, pid: this.process.pid }, "terminating app-server failed");
        }
    }

    private async writeMessage(message: Record<string, unknown>): Promise<void> {
        const line = `${SafeJSON.stringify(message, { jsonl: true })}\n`;
        await this.process.stdin.write(line);
        await this.process.stdin.flush?.();
    }

    private async readStdout(): Promise<void> {
        const reader = this.process.stdout.getReader();
        const decoder = new TextDecoder();
        let partial = "";

        try {
            for (;;) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }

                partial += decoder.decode(result.value, { stream: true });
                const lines = partial.split("\n");
                partial = lines.pop() ?? "";

                for (const line of lines) {
                    await this.handleLine(line);
                }
            }

            partial += decoder.decode();
            if (partial.trim()) {
                await this.handleLine(partial);
            }
        } catch (err) {
            if (!this.closed) {
                log.error({ err }, "reading app-server stdout failed");
                this.rejectPending(err instanceof Error ? err : new Error(String(err)));
            }
        } finally {
            reader.releaseLock();
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

    private async handleLine(line: string): Promise<void> {
        if (!line.trim()) {
            return;
        }

        let message: unknown;
        try {
            message = SafeJSON.parse(line, { strict: true });
        } catch (err) {
            log.warn({ err, line }, "ignoring invalid app-server JSON line");
            return;
        }

        if (!isRecord(message)) {
            log.warn({ message }, "ignoring non-object app-server message");
            return;
        }

        const id = message.id;
        const method = message.method;

        if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
            void this.handleServerRequest({ id, method, params: message.params }).catch((err) => {
                log.error({ err, id, method }, "answering app-server request failed");
            });
            return;
        }

        if (typeof id === "number" || typeof id === "string") {
            const pending = this.pending.get(id);
            if (!pending) {
                log.debug({ id }, "received response for unknown app-server request");
                return;
            }

            this.pending.delete(id);
            if ("error" in message) {
                pending.reject(responseError(message.error));
            } else {
                pending.resolve(message.result);
            }

            return;
        }

        if (typeof method === "string") {
            await this.options.onNotification?.({ method, params: message.params });
        }
    }

    private async handleServerRequest(request: RpcServerRequest): Promise<void> {
        if (!this.options.onServerRequest) {
            await this.writeMessage({
                id: request.id,
                error: { code: -32_601, message: `No handler for server request ${request.method}` },
            });
            return;
        }

        try {
            const result = await this.options.onServerRequest(request);
            await this.writeMessage({ id: request.id, result });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.writeMessage({ id: request.id, error: { code: -32_000, message } });
        }
    }

    private async watchExit(): Promise<void> {
        const code = await this.process.exited;
        const wasClosed = this.closed;
        this.closed = true;
        this.rejectPending(new Error(`Codex app-server exited with code ${code}`));

        if (!wasClosed) {
            await this.options.onExit?.(code);
        }
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }

        this.pending.clear();
    }
}

export function spawnAppServer(options: {
    cwd: string;
    home?: string;
    envOverrides?: Record<string, string>;
    config?: string[];
}): AppServerProcess {
    const cmd = ["codex", "app-server"];

    for (const config of options.config ?? []) {
        cmd.push("-c", config);
    }

    const childEnv = { ...env.getProcessEnv(), ...options.envOverrides };
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
