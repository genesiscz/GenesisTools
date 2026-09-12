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
            for await (const chunk of worker.stderr as ReadableStream<Uint8Array>) {
                const text = decoder.decode(chunk, { stream: true }).trimEnd();

                if (text.length > 0) {
                    logger.debug({ pid: worker.pid, stderr: text.slice(0, 2000) }, "node-repl worker stderr");
                }
            }
        } catch (error) {
            logger.debug({ error, pid: worker.pid }, "node-repl worker stderr stream ended");
        }
    }

    private async readResponses(worker: ReturnType<typeof Bun.spawn>): Promise<void> {
        const decoder = new TextDecoder();
        let buffered = "";

        for await (const chunk of worker.stdout as ReadableStream<Uint8Array>) {
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
        for (const [id, resolve] of this.pending) {
            resolve({ id, ok: false, text: "", images: [], error: reason });
        }
        this.pending.clear();
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

    async addModuleDir(dir: string): Promise<ReplResult> {
        this.moduleDirs.push(dir);
        const worker = this.ensureWorker();
        const id = this.nextId++;
        const started = performance.now();

        return new Promise<ReplResult>((resolve) => {
            this.pending.set(id, (response) =>
                resolve({ ...response, durationMs: Math.round(performance.now() - started) })
            );
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
