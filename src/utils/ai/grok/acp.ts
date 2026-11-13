/**
 * Persistent ACP client + pool for `grok agent stdio` (the app-server "leader").
 *
 * Why ACP instead of `grok -p`: each `grok -p` cold-boots (per-call re-auth +
 * leader respawn) ≈ 14s. ACP authenticates ONCE (methodId=cached_token — the
 * ~/.grok/auth.json credential) and reuses the warm process: ~4-5s/prompt. A
 * fresh session per prompt keeps calls independent (no conversation-context
 * bleed) while auth stays warm. Ported from the SkillOpt fable_clone cc.py
 * implementation (verified working 2026-07-22).
 *
 * One stdio pipe serializes calls per client; GrokAcpPool runs N independent
 * leader processes for real parallelism (a free-queue hands a warm backend to
 * each caller and blocks when all are busy).
 *
 * Note: ACP prompts run on the grok CLI's default model — the protocol takes
 * no per-prompt model override (same behavior as the SkillOpt original).
 *
 * Leader form (`leader: { socket }`): the client joins a running shared leader
 * (`grok agent --leader --leader-socket <sock> stdio`, the flags before `stdio`)
 * as a second client of the sessions a Grok TUI shows there. It lists them
 * (`session/list`) and prompts one (`session/prompt`); it never creates a
 * session of its own, and `session/load` on a live id fails with FS_NOT_FOUND,
 * so it is not used. Live-tested on grok 1.0.70, 2026-10-30.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { connectChildStdio } from "@genesiscz/utils/rpc/child-stdio";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import type { RpcDialect, RpcPeer } from "@genesiscz/utils/rpc/peer";
import { resolveGrokHome } from "./paths";

export class GrokAcpError extends Error {}

/** The agent answered the request with an error: it refused it, nothing was accepted. */
export class GrokAcpRefusedError extends GrokAcpError {}

interface RpcReply {
    result?: unknown;
    error?: unknown;
}

/** The pipes of a spawned `grok agent … stdio`; a Bun subprocess fits, and tests pass a fake agent. */
export interface GrokAcpTransport {
    stdin: { write(chunk: string): unknown; flush(): unknown };
    stdout: ReadableStream<Uint8Array>;
    exitCode: number | null;
    /** Settles with the exit code; a Bun subprocess has it, and without it the end of stdout ends the connection. */
    exited?: Promise<number>;
    kill(): void;
}

export type GrokAcpSpawn = (argv: string[], environment: Record<string, string | undefined>) => GrokAcpTransport;

export interface GrokAcpLeaderOptions {
    /** The leader's socket, as `grok agent leader --leader-socket` and the TUI's `--leader-socket` name it. */
    socket: string;
}

export interface GrokAcpOptions {
    binPath?: string;
    /** Per-prompt timeout (ms). */
    timeoutMs?: number;
    /** Join this running leader as a second client instead of starting an own agent. */
    leader?: GrokAcpLeaderOptions;
    /** The agent's environment (`GROK_HOME`, `GROK_AUTH_PATH`); the caller's own by default. */
    env?: Record<string, string | undefined>;
    /** Starts the agent process; `Bun.spawn` by default. */
    spawn?: GrokAcpSpawn;
}

/** One live session a leader lists. */
export interface GrokLeaderSession {
    sessionId: string;
    cwd?: string;
    title?: string;
    updatedAt?: string;
}

/**
 * How far `promptSession` waits. `queued`: until the leader puts the prompt in the session's queue (or runs it), the
 * acknowledgement a delivery needs. `completed`: until the turn the prompt started ends.
 */
export type GrokPromptWait = "queued" | "completed";

export type GrokPromptOutcome =
    | { outcome: "queued"; promptId?: string }
    | { outcome: "completed"; stopReason?: string; promptId?: string };

interface QueueWatcher {
    sessionId: string;
    text: string;
    resolve: (promptId: string | undefined) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

/** The `sessions` of a `session/list` result; rows without a session id are dropped. */
export function parseLeaderSessions(result: unknown): GrokLeaderSession[] {
    const rows = isRecord(result) && Array.isArray(result.sessions) ? result.sessions : [];
    return rows.flatMap((row: unknown) => {
        if (!isRecord(row)) {
            return [];
        }

        const sessionId = stringField(row, "sessionId");
        if (!sessionId) {
            return [];
        }

        const cwd = stringField(row, "cwd");
        const title = stringField(row, "title");
        const updatedAt = stringField(row, "updatedAt");
        return [
            { sessionId, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}), ...(updatedAt ? { updatedAt } : {}) },
        ];
    });
}

/**
 * The prompt id of `_x.ai/queue/changed` params when they show this text queued or running in this session. The
 * leader sends the queue (`entries[].text`) when it accepts the prompt, then `runningText` when it starts it.
 */
export function queuedPromptId(params: unknown, sessionId: string, text: string): string | undefined | false {
    if (!isRecord(params) || params.sessionId !== sessionId) {
        return false;
    }

    if (params.runningText === text) {
        return stringField(params, "runningPromptId");
    }

    const entries = Array.isArray(params.entries) ? params.entries : [];
    const entry = entries.find((candidate: unknown) => isRecord(candidate) && candidate.text === text);
    return isRecord(entry) ? stringField(entry, "id") : false;
}

function defaultSpawn(argv: string[], environment: Record<string, string | undefined>): GrokAcpTransport {
    return Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: environment });
}
/**
 * What `grok agent stdio` speaks: JSON-RPC 2.0 with the `jsonrpc` field, without `$/cancel` or `$/progress`. Every call
 * names its own deadline. A session/load or a long chat history can pass the default 8 MiB line, so the limit is higher.
 */
export const GROK_ACP_DIALECT: Partial<RpcDialect> = {
    jsonrpcField: true,
    cancel: false,
    progress: false,
    defaultDeadlineMs: 240_000,
    maxLineBytes: 256 * 1024 * 1024,
    errorEvidence: false,
};

function errorBody(error: RpcError): Record<string, unknown> {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class GrokAcpClient {
    private proc: GrokAcpTransport | undefined;
    private peer: RpcPeer | undefined;
    private collector: ((text: string) => void) | undefined;
    private readonly queueWatchers = new Set<QueueWatcher>();
    private chain: Promise<unknown> = Promise.resolve();
    private readonly bin: string;
    private readonly leader: GrokAcpLeaderOptions | undefined;
    private readonly environment: Record<string, string | undefined> | undefined;
    private readonly spawnAgent: GrokAcpSpawn;

    constructor(
        private readonly bid = 0,
        options: GrokAcpOptions = {}
    ) {
        this.bin = options.binPath ?? join(resolveGrokHome(), "bin", "grok");
        this.leader = options.leader;
        this.environment = options.env;
        this.spawnAgent = options.spawn ?? defaultSpawn;
    }

    /** The agent's argv: `grok agent stdio`, or `grok agent --leader --leader-socket <sock> stdio` for a leader. */
    argv(): string[] {
        return this.leader
            ? [this.bin, "agent", "--leader", "--leader-socket", this.leader.socket, "stdio"]
            : [this.bin, "agent", "stdio"];
    }

    /** Kill the backend so the next call respawns (used after errors); a call still waiting rejects. */
    reset(): void {
        this.peer?.close("grok-acp backend reset");

        try {
            this.proc?.kill();
        } catch {
            // already dead
        }

        this.proc = undefined;
        this.peer = undefined;
        this.collector = undefined;
        this.queueWatchers.clear();
    }

    private async ensure(): Promise<void> {
        if (this.proc && this.proc.exitCode === null && this.peer && !this.peer.closed) {
            return;
        }

        const started = performance.now();
        const argv = this.argv();
        this.proc = this.spawnAgent(argv, this.environment ?? env.getProcessEnv());
        this.peer = connectChildStdio({
            child: this.proc,
            dialect: GROK_ACP_DIALECT,
            exitReason: (code) => `grok-acp agent exited with code ${code}`,
            invalid: "ignore",
            log: logger.scoped("grok-acp").log,
            label: "grok-acp agent",
            logFields: { bid: this.bid },
            onNotification: (notification) => this.notification(notification.method, notification.params),
            // A message with a method is the agent's own request, whatever its id; this client serves none of them.
            handle: async ({ method }) => {
                throw new RpcError(JSON_RPC_ERRORS.methodNotFound, `grok-acp does not answer ${method}`);
            },
        }).peer;

        const handshakeTimeout = this.leader ? 15_000 : 60_000;
        const initialized = await this.rpc(
            "initialize",
            {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            },
            handshakeTimeout
        );
        if (this.leader && initialized.error) {
            throw new GrokAcpError(`grok-acp leader initialize failed: ${SafeJSON.stringify(initialized.error)}`);
        }

        // cached_token = the ~/.grok/auth.json credential (NOT xai.api_key, which 401s)
        const authenticated = await this.rpc("authenticate", { methodId: "cached_token" }, handshakeTimeout);
        if (this.leader && authenticated.error) {
            throw new GrokAcpError(`grok-acp leader authenticate failed: ${SafeJSON.stringify(authenticated.error)}`);
        }

        logger.debug(
            {
                bid: this.bid,
                leader: this.leader?.socket,
                argv: argv.slice(1),
                warmupMs: Math.round(performance.now() - started),
            },
            "grok-acp backend warm (init+auth)"
        );
    }

    private notification(method: string, params: unknown): void {
        if (method === "session/update") {
            const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
            const content = update && isRecord(update.content) ? update.content : undefined;
            if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text") {
                this.collector?.(typeof content.text === "string" ? content.text : "");
            }

            return;
        }

        if (method === "_x.ai/queue/changed") {
            this.queueChanged(params);
        }
    }

    private queueChanged(params: unknown): void {
        for (const watcher of this.queueWatchers) {
            const promptId = queuedPromptId(params, watcher.sessionId, watcher.text);
            if (promptId !== false) {
                this.queueWatchers.delete(watcher);
                watcher.resolve(promptId);
            }
        }
    }

    private requirePeer(): RpcPeer {
        if (!this.peer) {
            throw new GrokAcpError("grok-acp backend not running");
        }

        return this.peer;
    }

    /**
     * One request: the agent's error reply comes back as `error`, for the caller to judge. No reply within
     * `timeoutMs`, or the agent gone, throws.
     */
    private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcReply> {
        try {
            return { result: await this.requirePeer().request(method, params, { timeoutMs }) };
        } catch (error) {
            if (error instanceof RpcError) {
                return { error: errorBody(error) };
            }

            throw new GrokAcpError(`grok-acp ${method} failed: ${reason(error)}`);
        }
    }

    /** Run `fn` after every earlier call of this client finished; one stdio pipe carries one call at a time. */
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn);
        // keep the chain alive even when this call fails (serialization lock)
        this.chain = run.catch(() => undefined);
        return run;
    }

    private requireLeader(verb: string): GrokAcpLeaderOptions {
        if (!this.leader) {
            throw new GrokAcpError(`grok-acp ${verb} needs the leader form (options.leader.socket)`);
        }

        return this.leader;
    }

    /** The live sessions the leader holds (a TUI's included), with their cwd and title. Leader form only. */
    async listSessions(timeoutMs = 30_000): Promise<GrokLeaderSession[]> {
        const leader = this.requireLeader("listSessions");
        return this.serial(async () => {
            await this.ensure();
            const reply = await this.rpc("session/list", {}, timeoutMs);
            if (reply.error) {
                throw new GrokAcpError(`grok-acp session/list failed: ${SafeJSON.stringify(reply.error)}`);
            }

            const sessions = parseLeaderSessions(reply.result);
            logger.debug({ bid: this.bid, leader: leader.socket, sessions: sessions.length }, "grok-acp session/list");
            return sessions;
        });
    }

    /**
     * Send `text` as the next prompt of a session the leader holds. With `until: "queued"` it resolves once the leader
     * queued or started the prompt (the turn then runs in the leader, whatever this client does next); with
     * `"completed"` once the turn ended. A timeout throws, because the prompt may have been accepted. Leader form only.
     */
    async promptSession(
        sessionId: string,
        text: string,
        options: { until?: GrokPromptWait; timeoutMs?: number } = {}
    ): Promise<GrokPromptOutcome> {
        const leader = this.requireLeader("promptSession");
        const until = options.until ?? "completed";
        const timeoutMs = options.timeoutMs ?? 240_000;
        return this.serial(async () => {
            await this.ensure();
            let watcher: QueueWatcher | undefined;
            const queued = new Promise<string | undefined>((resolve) => {
                watcher = { sessionId, text, resolve };
                this.queueWatchers.add(watcher);
            });
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expired = new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), timeoutMs);
            });

            try {
                // The request's own deadline comes after `expired`, so a silent agent reads as a timeout; a queued
                // prompt's reply, which comes when its turn ends, is still dropped at that deadline.
                const replied = this.requirePeer()
                    .request(
                        "session/prompt",
                        { sessionId, prompt: [{ type: "text", text }] },
                        {
                            timeoutMs: timeoutMs + 1000,
                        }
                    )
                    .then(
                        (result) => ({ kind: "reply" as const, value: { result } as RpcReply }),
                        (error: unknown) =>
                            error instanceof RpcError
                                ? { kind: "reply" as const, value: { error: errorBody(error) } as RpcReply }
                                : { kind: "lost" as const, reason: reason(error) }
                    );
                const acknowledged = queued.then((promptId) => ({ kind: "queued" as const, promptId }));
                const first = await Promise.race(
                    until === "queued" ? [replied, acknowledged, expired] : [replied, expired]
                );

                if (first === "timeout") {
                    throw new GrokAcpError(
                        `grok-acp session/prompt to ${sessionId} got no ${until === "queued" ? "queue acknowledgement" : "end of turn"} within ${timeoutMs} ms; it may have been accepted`
                    );
                }

                if (first.kind === "lost") {
                    throw new GrokAcpError(
                        `grok-acp session/prompt to ${sessionId} lost the agent (${first.reason}); it may have been accepted`
                    );
                }

                if (first.kind === "queued") {
                    logger.debug(
                        { bid: this.bid, leader: leader.socket, sessionId, promptId: first.promptId },
                        "grok-acp prompt queued in the leader"
                    );
                    return { outcome: "queued", ...(first.promptId ? { promptId: first.promptId } : {}) };
                }

                if (first.value.error) {
                    throw new GrokAcpRefusedError(
                        `grok-acp session/prompt failed: ${SafeJSON.stringify(first.value.error)}`
                    );
                }

                const result = isRecord(first.value.result) ? first.value.result : {};
                const meta = isRecord(result._meta) ? result._meta : {};
                const stopReason = stringField(result, "stopReason");
                const promptId = stringField(meta, "promptId");
                logger.debug(
                    { bid: this.bid, leader: leader.socket, sessionId, stopReason, promptId },
                    "grok-acp prompt turn ended"
                );
                return {
                    outcome: "completed",
                    ...(stopReason ? { stopReason } : {}),
                    ...(promptId ? { promptId } : {}),
                };
            } finally {
                clearTimeout(timer);
                if (watcher) {
                    this.queueWatchers.delete(watcher);
                }
            }
        });
    }

    /** One prompt on a fresh ACP session (serialized per client, warm auth). Never in the leader form. */
    async call(prompt: string, timeoutMs = 240_000): Promise<string> {
        if (this.leader) {
            throw new GrokAcpError("grok-acp call() creates a session; a leader client uses promptSession()");
        }

        return this.serial(async () => {
            await this.ensure();
            const started = performance.now();

            const sessionReply = await this.rpc("session/new", { cwd: tmpdir(), mcpServers: [] }, 60_000);
            const sessionId = (sessionReply.result as { sessionId?: string } | undefined)?.sessionId;
            if (!sessionId) {
                throw new GrokAcpError(`grok-acp session/new failed: ${SafeJSON.stringify(sessionReply)}`);
            }

            const chunks: string[] = [];
            this.collector = (text) => chunks.push(text);
            try {
                const promptReply = await this.rpc(
                    "session/prompt",
                    { sessionId, prompt: [{ type: "text", text: prompt }] },
                    timeoutMs
                );

                if (promptReply.error) {
                    throw new GrokAcpError(`grok-acp prompt error: ${SafeJSON.stringify(promptReply.error)}`);
                }

                const text = chunks.join("").trim();
                if (!text) {
                    throw new GrokAcpError(
                        `grok-acp empty reply (stop=${SafeJSON.stringify(promptReply.result ?? null)})`
                    );
                }

                logger.debug(
                    {
                        bid: this.bid,
                        elapsedMs: Math.round(performance.now() - started),
                        inChars: prompt.length,
                        outChars: text.length,
                    },
                    "grok-acp prompt ok"
                );
                return text;
            } finally {
                this.collector = undefined;
            }
        });
    }
}

export interface GrokAcpPoolOptions extends Omit<GrokAcpOptions, "leader"> {
    /** Number of independent leader processes (default 1). */
    size?: number;
    retries?: number;
}

export class GrokAcpPool {
    private readonly clients: GrokAcpClient[] = [];
    private readonly free: GrokAcpClient[] = [];
    private readonly waiters: ((client: GrokAcpClient) => void)[] = [];
    private readonly retries: number;

    constructor(options: GrokAcpPoolOptions = {}) {
        const size = Math.max(1, options.size ?? 1);
        for (let i = 0; i < size; i++) {
            const client = new GrokAcpClient(i + 1, options);
            this.clients.push(client);
            this.free.push(client);
        }

        this.retries = options.retries ?? 4;
    }

    private acquire(): Promise<GrokAcpClient> {
        const client = this.free.pop();
        if (client) {
            return Promise.resolve(client);
        }

        return new Promise((resolve) => this.waiters.push(resolve));
    }

    private release(client: GrokAcpClient): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(client);
        } else {
            this.free.push(client);
        }
    }

    /** Run one prompt on any free warm backend, with respawn-and-backoff retries. */
    async call(prompt: string, timeoutMs = 240_000): Promise<string> {
        let lastError = "";
        for (let attempt = 0; attempt < this.retries; attempt++) {
            const client = await this.acquire();
            try {
                return await client.call(prompt, timeoutMs);
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                client.reset(); // force respawn on this backend's next use
                logger.warn({ attempt: attempt + 1, error: lastError }, "grok-acp call failed; backend reset");
                await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt * 1000, 15_000)));
            } finally {
                this.release(client);
            }
        }

        throw new GrokAcpError(`grok-acp failed after ${this.retries} attempts: ${lastError}`);
    }

    /** Kill all backends (call at the end of a batch run). */
    shutdown(): void {
        for (const client of this.clients) {
            client.reset();
        }
    }
}
