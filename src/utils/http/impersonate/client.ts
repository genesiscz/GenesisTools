import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Subprocess } from "bun";

/**
 * HTTP with a real Chrome TLS/HTTP2/header fingerprint, for sites behind Cloudflare Bot Management that answer
 * Bun's fetch with a 403 challenge page (Alza: measured 2026-11-01, plain fetch and every `impit` profile 403,
 * curl_cffi 200). A long-lived Python sidecar (`sidecar.py`) runs curl_cffi through `uv`, so the only machine
 * requirement is `uv` on PATH; the first start downloads curl_cffi into uv's cache.
 */

const SIDECAR_PATH = join(moduleDir(import.meta), "sidecar.py");
const DEFAULT_TIMEOUT_MS = 60_000;
/** The sidecar enforces `timeoutMs`; this margin covers its start and the reply line. */
const REPLY_MARGIN_MS = 15_000;
const STDERR_TAIL_CHARS = 2_000;

export type ImpersonateProfile = "chrome" | "safari" | "firefox" | "edge";

export interface ImpersonatedRequest {
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    followRedirects?: boolean;
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
}

interface SidecarReply {
    id: number;
    status: number;
    url: string;
    headers: Record<string, string>;
    body: string;
    error: string | null;
}

interface Pending {
    resolve: (reply: SidecarReply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class ImpersonatedHttpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImpersonatedHttpError";
    }
}

export class ImpersonatedHttpClient {
    private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private stderrTail = "";
    private readonly profile: ImpersonateProfile;
    private readonly label: string;

    constructor(private readonly options: ImpersonatedHttpClientOptions = {}) {
        this.profile = options.profile ?? "chrome";
        this.label = options.label ?? "impersonate";
    }

    async request(req: ImpersonatedRequest): Promise<ImpersonatedResponse> {
        const proc = this.ensureStarted();
        const id = this.nextId++;
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const started = performance.now();
        const line = SafeJSON.stringify({
            id,
            url: req.url,
            method: req.method ?? "GET",
            headers: req.headers ?? {},
            body: req.body === undefined ? undefined : Buffer.from(req.body, "utf8").toString("base64"),
            impersonate: this.profile,
            timeoutMs,
            followRedirects: req.followRedirects ?? true,
        });

        const reply = await new Promise<SidecarReply>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ImpersonatedHttpError(`${req.method ?? "GET"} ${req.url}: no reply in ${timeoutMs} ms`));
            }, timeoutMs + REPLY_MARGIN_MS);
            this.pending.set(id, { resolve, reject, timer });
            proc.stdin.write(`${line}\n`);
            proc.stdin.flush();
        });

        const ms = Math.round(performance.now() - started);
        if (reply.error) {
            logger.debug({ label: this.label, url: req.url, ms, error: reply.error }, "impersonated request failed");
            throw new ImpersonatedHttpError(`${req.method ?? "GET"} ${req.url}: ${reply.error}`);
        }

        logger.debug(
            { label: this.label, method: req.method ?? "GET", url: req.url, status: reply.status, ms },
            "impersonated request"
        );
        return {
            status: reply.status,
            url: reply.url,
            headers: reply.headers,
            text: Buffer.from(reply.body, "base64").toString("utf8"),
        };
    }

    /** Ends the sidecar. A CLI run must call it, or the open pipes keep the process alive. */
    async close(): Promise<void> {
        const proc = this.proc;
        if (!proc) {
            return;
        }

        this.proc = null;
        try {
            proc.stdin.end();
        } catch (error) {
            logger.debug({ error, label: this.label }, "impersonate sidecar stdin already closed");
        }

        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
        if (!exited) {
            proc.kill();
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private ensureStarted(): Subprocess<"pipe", "pipe", "pipe"> {
        if (this.proc) {
            return this.proc;
        }

        const uv = Bun.which("uv");
        if (!uv) {
            throw new ImpersonatedHttpError(
                "uv is not installed. The Chrome-fingerprint HTTP client runs curl_cffi through uv: brew install uv"
            );
        }

        const cmd = [uv, "run", "--no-project", "--quiet", "--with", "curl_cffi", "python", "-I", SIDECAR_PATH];
        logger.debug({ label: this.label, cmd, profile: this.profile }, "starting impersonate sidecar");
        const proc = Bun.spawn(cmd, {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, IMPERSONATE_PROXY_URL: this.options.proxyUrl ?? "" },
        });
        this.proc = proc;
        this.stderrTail = "";
        void this.readReplies(proc);
        void this.readStderr(proc);
        void proc.exited.then((code) => this.onExit(proc, code));
        return proc;
    }

    private async readReplies(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of proc.stdout) {
            buffer += decoder.decode(chunk, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) {
                    this.deliver(line);
                }

                newline = buffer.indexOf("\n");
            }
        }
    }

    private deliver(line: string): void {
        let reply: SidecarReply;
        try {
            reply = SafeJSON.parse(line, { strict: true }) as SidecarReply;
        } catch (error) {
            logger.warn(
                { error, label: this.label, line: line.slice(0, 200) },
                "impersonate sidecar wrote a non-JSON line"
            );
            return;
        }

        const waiter = this.pending.get(reply.id);
        if (!waiter) {
            logger.debug({ label: this.label, id: reply.id }, "impersonate reply for a request that already timed out");
            return;
        }

        clearTimeout(waiter.timer);
        this.pending.delete(reply.id);
        waiter.resolve(reply);
    }

    private async readStderr(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stderr) {
            this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
        }
    }

    private onExit(proc: Subprocess<"pipe", "pipe", "pipe">, code: number | null): void {
        if (this.proc === proc) {
            this.proc = null;
        }

        if (this.pending.size === 0) {
            logger.debug({ label: this.label, code }, "impersonate sidecar exited");
            return;
        }

        const tail = this.stderrTail.trim();
        logger.warn({ label: this.label, code, pending: this.pending.size, stderr: tail }, "impersonate sidecar died");
        for (const [id, waiter] of this.pending) {
            clearTimeout(waiter.timer);
            waiter.reject(
                new ImpersonatedHttpError(`impersonate sidecar exited with code ${code}${tail ? `: ${tail}` : ""}`)
            );
            this.pending.delete(id);
        }
    }
}
