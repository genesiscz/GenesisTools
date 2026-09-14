import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Parent side of the REPL: owns one worker process, one request at a time, and the wall clock.
 * A turn that overruns is answered by killing the worker and starting a fresh one, so every
 * binding is lost, which the error says. `reset()` is the same operation on purpose.
 */

export interface ReplImage {
    mimeType: string;
    data: string;
    path: string;
}

export interface ReplResult {
    ok: boolean;
    text: string;
    images: ReplImage[];
    error?: string;
    stack?: string;
    durationMs: number;
}

interface WorkerResponse {
    id: number;
    ok: boolean;
    text: string;
    images: ReplImage[];
    error?: string;
    stack?: string;
}

const WORKER_PATH = join(import.meta.dir, "worker.ts");

/**
 * What to show a caller for one result. A timeout or a worker exit reports through `error` and
 * leaves `text` empty, so rendering `text` alone answers those failures with a blank message.
 */
export function resultMessage(result: Pick<ReplResult, "ok" | "text" | "error" | "stack">): string {
    if (result.ok) {
        return result.text;
    }

    return (result.stack ?? result.error ?? result.text) || "unknown error";
}

export class ReplEngine {
    private worker: ReturnType<typeof Bun.spawn> | null = null;
    private nextId = 1;
    private pending = new Map<number, (response: WorkerResponse) => void>();
    private moduleDirs: string[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    readonly defaultTimeoutMs: number;

    constructor(options: { defaultTimeoutMs?: number } = {}) {
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    }

    private ensureWorker(): ReturnType<typeof Bun.spawn> {
        if (this.worker && this.worker.exitCode === null) {
            return this.worker;
        }

        const worker = Bun.spawn([process.execPath, WORKER_PATH], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        logger.debug({ pid: worker.pid }, "node-repl worker started");
        this.worker = worker;
        void this.readResponses(worker);
        void this.drainStderr(worker);
        // A respawned worker starts empty; re-register the directories the session added.
        for (const dir of this.moduleDirs) {
            this.send(worker, { id: this.nextId++, op: "addDir", dir });
        }

        return worker;
    }

    /**
     * An undrained 64 KB pipe blocks the writer mid-write, and from the parent that is
     * indistinguishable from a long computation: the turn burns its whole 30-second budget and
     * then the worker is killed with every binding lost. A `console.error` loop or a noisy
     * dependency is enough. The same hazard is handled three files away in
     * src/control/lib/peekaboo.ts, which says so in its own comment.
     */
    private async drainStderr(worker: ReturnType<typeof Bun.spawn>): Promise<void> {
        const decoder = new TextDecoder();

        try {
            for await (const chunk of worker.stderr as unknown as AsyncIterable<Uint8Array>) {
                const text = decoder.decode(chunk, { stream: true }).trimEnd();

                if (text.length > 0) {
                    logger.debug({ pid: worker.pid, stderr: text.slice(0, 2000) }, "node-repl worker stderr");
                }
            }
        } catch (error) {
            logger.debug({ error, pid: worker.pid }, "node-repl worker stderr stream ended");
        }
    }

    /**
     * The worker's stdout ending is the only in-band notice that it is gone — it may have died
     * before answering, or never started at all (a malformed trust.json throws at its module
     * top level). Every request still waiting is settled here, so a caller learns immediately
     * instead of waiting out a wall clock that a request without a timer never even starts.
     */
    private async readResponses(worker: ReturnType<typeof Bun.spawn>): Promise<void> {
        try {
            await this.pumpResponses(worker);
        } catch (error) {
            // Called as `void this.readResponses(worker)`, so a rethrow here is an unhandled
            // rejection rather than anything a caller can act on. A killed worker's stdout can
            // error mid-read; the `finally` below still settles whoever was waiting.
            logger.debug({ error, pid: worker.pid }, "node-repl worker stdout stream ended");
        } finally {
            // A worker replaced in the meantime owns `this.pending` now; this one must not
            // settle requests that belong to its successor.
            if (this.worker === worker) {
                this.worker = null;
                this.settlePending(
                    `the node-repl worker exited (code ${worker.exitCode ?? "unknown"}) before answering`
                );
            }
        }
    }

    private settlePending(reason: string): void {
        for (const [id, resolve] of this.pending) {
            resolve({ id, ok: false, text: "", images: [], error: reason });
        }

        this.pending.clear();
    }

    private async pumpResponses(worker: ReturnType<typeof Bun.spawn>): Promise<void> {
        const decoder = new TextDecoder();
        let buffered = "";

        // `AsyncIterable`, not `ReadableStream`: Bun's streams ARE async-iterable at runtime, but
        // the DOM ReadableStream type that wins here does not declare it, which `tsc` reports as
        // TS2504 while `tsgo` accepts. Naming what the loop actually needs satisfies both.
        for await (const chunk of worker.stdout as unknown as AsyncIterable<Uint8Array>) {
            buffered += decoder.decode(chunk, { stream: true });
            let newline = buffered.indexOf("\n");

            while (newline >= 0) {
                const line = buffered.slice(0, newline).trim();
                buffered = buffered.slice(newline + 1);

                if (line) {
                    try {
                        const response = SafeJSON.parse(line, { strict: true }) as WorkerResponse;
                        this.pending.get(response.id)?.(response);
                        this.pending.delete(response.id);
                    } catch (error) {
                        logger.warn(
                            { error, line: line.slice(0, 200) },
                            "node-repl worker wrote a line that is not JSON"
                        );
                    }
                }

                newline = buffered.indexOf("\n");
            }
        }
    }

    private send(worker: ReturnType<typeof Bun.spawn>, request: Record<string, unknown>): void {
        const stdin = worker.stdin as { write(data: string): void; flush(): void };
        stdin.write(`${SafeJSON.stringify(request)}\n`);
        stdin.flush();
    }

    private killWorker(reason: string): void {
        const worker = this.worker;
        this.worker = null;

        if (!worker) {
            return;
        }

        logger.debug({ pid: worker.pid, reason }, "node-repl worker killed");
        worker.kill();
        this.settlePending(reason);
    }

    /** Runs one turn. Turns are serialised: the context is one, and so is its output buffer. */
    run(code: string, timeoutMs = this.defaultTimeoutMs): Promise<ReplResult> {
        const turn = this.queue.then(() => this.runNow(code, timeoutMs));
        this.queue = turn.catch(() => undefined);
        return turn;
    }

    private runNow(code: string, timeoutMs: number): Promise<ReplResult> {
        const worker = this.ensureWorker();
        const id = this.nextId++;
        const started = performance.now();

        return new Promise<ReplResult>((resolve) => {
            const timer = setTimeout(() => {
                this.killWorker(`turn exceeded ${timeoutMs} ms; the worker was killed and every binding is gone`);
            }, timeoutMs);
            this.pending.set(id, (response) => {
                clearTimeout(timer);
                resolve({ ...response, durationMs: Math.round(performance.now() - started) });
            });
            this.send(worker, { id, op: "run", code });
        });
    }

    /** Same wall clock as a turn: a registration nobody answers must not hang the caller forever. */
    async addModuleDir(dir: string): Promise<ReplResult> {
        this.moduleDirs.push(dir);
        const worker = this.ensureWorker();
        const id = this.nextId++;
        const started = performance.now();

        return new Promise<ReplResult>((resolve) => {
            const timer = setTimeout(() => {
                this.killWorker(
                    `registering ${dir} exceeded ${this.defaultTimeoutMs} ms; the worker was killed and every binding is gone`
                );
            }, this.defaultTimeoutMs);
            this.pending.set(id, (response) => {
                clearTimeout(timer);
                resolve({ ...response, durationMs: Math.round(performance.now() - started) });
            });
            this.send(worker, { id, op: "addDir", dir });
        });
    }

    reset(): void {
        this.killWorker("reset");
    }

    dispose(): void {
        this.killWorker("dispose");
    }
}
