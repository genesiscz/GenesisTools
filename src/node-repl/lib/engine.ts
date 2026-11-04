import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { TemporaryArtifacts } from "@genesiscz/utils/fs/temporary-artifacts";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { recorderStartSchema } from "@genesiscz/utils/repl/toolsets/recorder";
import { type LibraryRecording, startRecording } from "@genesiscz/utils/screen-recorder/start";
import type { FrameRecorder } from "@genesiscz/utils/screen-recorder/types";

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
function spawnWorker(ipc: (message: unknown) => void) {
    return Bun.spawn([process.execPath, WORKER_PATH], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ipc,
        env: env.getProcessEnv(),
    });
}
type ReplWorker = ReturnType<typeof spawnWorker>;

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                return;
            }

            yield chunk.value;
        }
    } finally {
        reader.releaseLock();
    }
}

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

export interface ReplEngineOptions {
    recorder?: { create(): Promise<FrameRecorder> };
    defaultTimeoutMs?: number;
    /** Toolset ids from `REPL_TOOLSETS`, preloaded into every worker this engine spawns. */
    toolsets?: readonly string[];
    /** The budget of one preload, apart from every turn's timeout: a toolset may build a native binary first. */
    preloadTimeoutMs?: number;
}

/** How long `shutdown` and `reset` give the toolsets to release what they started before the worker is killed. */
const DISPOSE_TIMEOUT_MS = 10_000;

export class ReplEngine {
    private worker: ReplWorker | null = null;
    private ready: Promise<WorkerResponse> | null = null;
    private nextId = 1;
    private pending = new Map<number, (response: WorkerResponse) => void>();
    private moduleDirs: string[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    private scratch?: TemporaryArtifacts;
    private readonly recordings = new Set<LibraryRecording>();
    private readonly recordingStarts = new Set<Promise<void>>();
    readonly defaultTimeoutMs: number;
    readonly preloadTimeoutMs: number;
    readonly toolsets: readonly string[];

    constructor(private readonly options: ReplEngineOptions = {}) {
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
        this.preloadTimeoutMs = options.preloadTimeoutMs ?? 120_000;
        this.toolsets = options.toolsets ?? [];
    }

    /**
     * The live worker with its toolsets loaded, or the preload's failure. A respawned worker starts empty, so the
     * session's module directories are registered again and the toolsets preloaded again, once per spawn.
     */
    private ensureWorker(): Promise<WorkerResponse> {
        if (this.worker && this.worker.exitCode === null && this.ready) {
            return this.ready;
        }

        if (this.worker) {
            this.workerStopped();
        }

        let worker: ReplWorker;
        worker = spawnWorker((message) => {
            if (
                typeof message !== "object" ||
                message === null ||
                !("recordingStart" in message) ||
                !("id" in message)
            ) {
                return;
            }

            const requestId = message.id;
            const task = (async () => {
                try {
                    const options = recorderStartSchema.parse(message.recordingStart);
                    const { FRAME_RECORDERS } = await import("@genesiscz/utils/screen-recorder/recorders");
                    const { ensureBinaryAsync } = await import("@app/control/lib/runner");
                    const recording = await startRecording({
                        ...options,
                        ocr: options.ocr ? { ...options.ocr, enabled: options.ocr.enabled ?? true } : undefined,
                        recorder: this.options.recorder
                            ? await this.options.recorder.create()
                            : FRAME_RECORDERS.native({ axTool: async (input) => [await ensureBinaryAsync(input)] }),
                    });
                    this.recordings.add(recording);

                    if (worker.exitCode === null) {
                        worker.send({ id: requestId, recordingId: recording.id });
                    }
                } catch (error) {
                    if (worker.exitCode === null) {
                        worker.send({ id: requestId, error: String(error) });
                    }
                }
            })();
            this.recordingStarts.add(task);
            void task.finally(() => this.recordingStarts.delete(task));
        });
        logger.debug({ pid: worker.pid, toolsets: this.toolsets }, "node-repl worker started");
        this.worker = worker;
        void this.readResponses(worker);
        void this.drainStderr(worker);

        for (const dir of this.moduleDirs) {
            this.send(worker, { id: this.nextId++, op: "addDir", dir });
        }

        this.ready = this.preload(worker);
        return this.ready;
    }

    private async preload(worker: ReplWorker): Promise<WorkerResponse> {
        if (this.toolsets.length === 0) {
            return { id: 0, ok: true, text: "", images: [] };
        }

        this.scratch = new TemporaryArtifacts({ prefix: "node-repl-toolsets", maxFiles: 1 });
        const response = await this.request(
            worker,
            { op: "preload", toolsets: [...this.toolsets], scratchDir: this.scratch.allocateDirectory() },
            {
                timeoutMs: this.preloadTimeoutMs,
                onTimeout: `preloading ${this.toolsets.join(", ")} exceeded ${this.preloadTimeoutMs} ms; the worker was killed`,
            }
        );

        if (!response.ok) {
            logger.warn({ error: response.error, toolsets: this.toolsets }, "node-repl toolset preload failed");

            if (this.worker === worker) {
                this.killWorker(`toolset preload failed: ${response.error ?? "unknown error"}`);
            }
        }

        return response;
    }

    private workerStopped(): void {
        this.ready = null;
        this.scratch?.dispose();
        this.scratch = undefined;
    }

    /**
     * An undrained 64 KB pipe blocks the writer mid-write, and from the parent that is
     * indistinguishable from a long computation: the turn burns its whole 30-second budget and
     * then the worker is killed with every binding lost. A `console.error` loop or a noisy
     * dependency is enough. The same hazard is handled three files away in
     * src/control/lib/peekaboo.ts, which says so in its own comment.
     */
    private async drainStderr(worker: ReplWorker): Promise<void> {
        const decoder = new TextDecoder();

        try {
            for await (const chunk of streamChunks(worker.stderr)) {
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
    private async readResponses(worker: ReplWorker): Promise<void> {
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
                this.workerStopped();
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

    private async pumpResponses(worker: ReplWorker): Promise<void> {
        const decoder = new TextDecoder();
        let buffered = "";

        for await (const chunk of streamChunks(worker.stdout)) {
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

    private send(worker: ReplWorker, request: Record<string, unknown>): void {
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
        this.workerStopped();
        this.settlePending(reason);
    }

    /** One request on the worker's own clock; a request nobody answers kills the worker instead of hanging the caller. */
    private request(
        worker: ReplWorker,
        payload: Record<string, unknown>,
        options: { timeoutMs: number; onTimeout: string }
    ): Promise<WorkerResponse> {
        const id = this.nextId++;

        return new Promise<WorkerResponse>((resolve) => {
            const timer = setTimeout(() => {
                if (this.worker === worker) {
                    this.killWorker(options.onTimeout);
                } else {
                    this.pending.delete(id);
                    resolve({ id, ok: false, text: "", images: [], error: options.onTimeout });
                }
            }, options.timeoutMs);
            this.pending.set(id, (response) => {
                clearTimeout(timer);
                resolve(response);
            });
            this.send(worker, { ...payload, id });
        });
    }

    /** Runs one turn. Turns are serialised: the context is one, and so is its output buffer. */
    run(code: string, timeoutMs = this.defaultTimeoutMs): Promise<ReplResult> {
        const turn = this.queue.then(() => this.runNow(code, timeoutMs));
        this.queue = turn.catch(() => undefined);
        return turn;
    }

    private async runNow(code: string, timeoutMs: number): Promise<ReplResult> {
        const started = performance.now();
        const ready = await this.ensureWorker();
        const worker = this.worker;

        if (!ready.ok || !worker) {
            return {
                ok: false,
                text: ready.text,
                images: ready.images,
                error: `toolset preload failed: ${ready.error ?? "the worker exited"}`,
                stack: ready.stack,
                durationMs: Math.round(performance.now() - started),
            };
        }

        const turnStarted = performance.now();
        const response = await this.request(
            worker,
            { op: "run", code },
            {
                timeoutMs,
                onTimeout: `turn exceeded ${timeoutMs} ms; the worker was killed and every binding is gone`,
            }
        );
        return { ...response, durationMs: Math.round(performance.now() - turnStarted) };
    }

    /** Same wall clock as a turn: a registration nobody answers must not hang the caller forever. */
    async addModuleDir(dir: string): Promise<ReplResult> {
        this.moduleDirs.push(dir);
        const started = performance.now();
        const ready = await this.ensureWorker();
        const worker = this.worker;

        if (!ready.ok || !worker) {
            return { ...ready, ok: false, durationMs: Math.round(performance.now() - started) };
        }

        const response = await this.request(
            worker,
            { op: "addDir", dir },
            {
                timeoutMs: this.defaultTimeoutMs,
                onTimeout: `registering ${dir} exceeded ${this.defaultTimeoutMs} ms; the worker was killed and every binding is gone`,
            }
        );
        return { ...response, durationMs: Math.round(performance.now() - started) };
    }

    /** Asks the worker's toolsets to release what they started, then kills it. Waits behind a running turn. */
    async shutdown(reason = "shutdown"): Promise<void> {
        const stop = this.queue.then(async () => {
            const worker = this.worker;

            if (worker && worker.exitCode === null && this.toolsets.length > 0) {
                const response = await this.request(
                    worker,
                    { op: "dispose" },
                    {
                        timeoutMs: DISPOSE_TIMEOUT_MS,
                        onTimeout: `disposing the toolsets exceeded ${DISPOSE_TIMEOUT_MS} ms`,
                    }
                );

                if (!response.ok) {
                    logger.warn({ error: response.error }, "node-repl toolset dispose failed");
                }
            }

            await Promise.all(this.recordingStarts);

            const results = await Promise.allSettled([...this.recordings].map((recording) => recording.stop()));
            this.recordings.clear();
            this.killWorker(reason);
            const failures = results.filter((result) => result.status === "rejected");

            if (failures.length > 0) {
                throw new AggregateError(
                    failures.map((result) => result.reason),
                    "Recording post-processing failed"
                );
            }
        });
        this.queue = stop.catch(() => undefined);
        await stop;
    }

    /** A fresh worker on the next turn: every binding is gone, the toolsets are disposed and preloaded again. */
    reset(): Promise<void> {
        return this.shutdown("reset");
    }

    /** Synchronous last resort (process exit): kills the worker without asking its toolsets. */
    dispose(): void {
        this.killWorker("dispose");
    }
}
