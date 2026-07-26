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
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { resolveGrokHome } from "./paths";

export class GrokAcpError extends Error {}

interface RpcReply {
    result?: unknown;
    error?: unknown;
}

interface PendingRpc {
    resolve: (reply: RpcReply) => void;
}

export interface GrokAcpOptions {
    binPath?: string;
    /** Per-prompt timeout (ms). */
    timeoutMs?: number;
}

export class GrokAcpClient {
    private proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
    private nextId = 0;
    private readonly pending = new Map<number, PendingRpc>();
    private collector: ((text: string) => void) | undefined;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly bin: string;

    constructor(
        private readonly bid = 0,
        options: GrokAcpOptions = {}
    ) {
        this.bin = options.binPath ?? join(resolveGrokHome(), "bin", "grok");
    }

    /** Kill the backend so the next call respawns (used after errors). */
    reset(): void {
        try {
            this.proc?.kill();
        } catch {
            // already dead
        }

        this.proc = undefined;
        this.pending.clear();
        this.collector = undefined;
    }

    private async ensure(): Promise<void> {
        if (this.proc && this.proc.exitCode === null) {
            return;
        }

        const started = performance.now();
        this.proc = Bun.spawn([this.bin, "agent", "stdio"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
        });
        this.readLoop(this.proc).catch((err) => {
            logger.debug({ bid: this.bid, error: err }, "grok-acp read loop ended");
        });

        await this.rpc(
            "initialize",
            {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            },
            60_000
        );
        // cached_token = the ~/.grok/auth.json credential (NOT xai.api_key, which 401s)
        await this.rpc("authenticate", { methodId: "cached_token" }, 60_000);
        logger.debug(
            { bid: this.bid, warmupMs: Math.round(performance.now() - started) },
            "grok-acp backend warm (init+auth)"
        );
    }

    private async readLoop(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<void> {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf("\n");
            while (nl !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                nl = buffer.indexOf("\n");

                if (!line) {
                    continue;
                }

                let obj: {
                    id?: number;
                    method?: string;
                    result?: unknown;
                    error?: unknown;
                    params?: { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
                };
                try {
                    obj = SafeJSON.parse(line, { strict: true });
                } catch {
                    continue;
                }

                if (obj.method === "session/update") {
                    const update = obj.params?.update;
                    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                        this.collector?.(update.content.text ?? "");
                    }

                    continue;
                }

                if (obj.id !== undefined && this.pending.has(obj.id)) {
                    const pending = this.pending.get(obj.id);
                    this.pending.delete(obj.id);
                    pending?.resolve({ result: obj.result, error: obj.error });
                }
            }
        }
    }

    private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcReply> {
        const proc = this.proc;
        if (!proc?.stdin) {
            throw new GrokAcpError("grok-acp backend not running");
        }

        this.nextId += 1;
        const id = this.nextId;
        const reply = new Promise<RpcReply>((resolve) => {
            this.pending.set(id, { resolve });
        });

        proc.stdin.write(`${SafeJSON.stringify({ jsonrpc: "2.0", id, method, params }, { strict: true })}\n`);
        await proc.stdin.flush();

        const timeout = new Promise<RpcReply>((resolve) => {
            setTimeout(() => resolve({ error: { timeout: true, method } }), timeoutMs);
        });
        const result = await Promise.race([reply, timeout]);
        this.pending.delete(id);
        return result;
    }

    /** One prompt on a fresh ACP session (serialized per client, warm auth). */
    async call(prompt: string, timeoutMs = 240_000): Promise<string> {
        const run = this.chain.then(async () => {
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

        // keep the chain alive even when this call fails (serialization lock)
        this.chain = run.catch(() => undefined);
        return run;
    }
}

export interface GrokAcpPoolOptions extends GrokAcpOptions {
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
