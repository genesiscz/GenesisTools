import { spawn } from "node:child_process";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface JsonLineTransport {
    request(options: { input: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
    close(): void;
}

/** One outstanding request; cancellation terminates the owned process group rather than replaying input. */
export class JsonLineProcess implements JsonLineTransport {
    private readonly child;
    private pending?: { resolve(value: unknown): void; reject(error: Error): void };
    private closed = false;
    constructor(options: { command: string[] }) {
        if (!options.command.length) {
            throw new Error("A child command is required.");
        }
        this.child = spawn(options.command[0], options.command.slice(1), {
            stdio: "pipe",
            detached: true,
            env: env.getProcessEnv(),
        });
        this.child.on("error", (error) => this.stop(error));
        this.child.stdin.on("error", (error) => this.stop(error));
        this.child.stderr.on("data", (chunk) =>
            logger.debug({ stderr: String(chunk).slice(0, 2000) }, "JSON-line child stderr")
        );
        void this.read();
    }
    private stop(error: Error) {
        this.pending?.reject(error);
        this.pending = undefined;
        if (!this.closed && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
            try {
                process.kill(-this.child.pid, "SIGTERM");
            } catch (cause) {
                logger.debug({ error: cause }, "JSON-line child group already ended");
            }
        }
        this.closed = true;
    }
    private async read() {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for await (const chunk of this.child.stdout) {
                buffer += decoder.decode(chunk, { stream: true });
                if (buffer.length > 1_000_000) {
                    throw new Error("JSON-line response exceeds 1 MB.");
                }
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (line.trim()) {
                        const value: unknown = SafeJSON.parse(line, { strict: true });
                        this.pending?.resolve(value);
                        this.pending = undefined;
                    }
                    newline = buffer.indexOf("\n");
                }
            }
            this.stop(new Error("Child ended; any in-flight action has unknown outcome. No retry."));
        } catch (error) {
            this.stop(error instanceof Error ? error : new Error("JSON-line stream failed."));
        }
    }
    async request(options: { input: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }) {
        options.signal?.throwIfAborted();
        const timeoutMs = options.timeoutMs ?? 30000;
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || this.closed || this.pending) {
            throw new Error("Invalid deadline, closed transport or concurrent request.");
        }
        const payload = `${SafeJSON.stringify(options.input)}\n`;
        if (Buffer.byteLength(payload) > 65536) {
            throw new Error("JSON-line request exceeds 64 KB.");
        }
        const cancel = () =>
            this.stop(new Error("Child cancelled; any in-flight action has unknown outcome. No retry."));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const response = new Promise<unknown>((resolve, reject) => {
                this.pending = { resolve, reject };
                timer = setTimeout(
                    () => this.stop(new Error("Child deadline reached; action outcome unknown. No retry.")),
                    timeoutMs
                );
                this.child.stdin.write(payload, (error) => {
                    if (error) {
                        this.stop(error);
                    }
                });
            });
            options.signal?.addEventListener("abort", cancel, { once: true });
            return await response;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", cancel);
        }
    }
    close() {
        if (this.pending) {
            this.stop(new Error("Session closed; action outcome unknown. No retry."));
            return;
        }
        this.child.stdin.end();
        const timer = setTimeout(() => this.stop(new Error("Child did not exit after EOF.")), 1000);
        timer.unref();
        this.child.once("exit", () => clearTimeout(timer));
    }
}
