import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { InputGuard } from "./guard";
import type { JobInfo, JobResult, JobState, ProgressEvent, StepReport } from "./types";

const { log } = logger.scoped("jobs");

/** How many events a job keeps for `job.events`; listeners see every one. */
const KEEP_EVENTS = 500;

export interface StepContext<S> {
    job: string;
    step: string;
    index: number;
    state: S;
    signal: AbortSignal;
    /** Reports the step's own progress, in its own unit. */
    progress(event: { done: number; total: number; unit: string; message?: string }): void;
    /** The absolute path to write; throws OverwriteInputError when the path is an input of the job. */
    claim(path: string): string;
    /** Marks one more file as an input that no later step may write. */
    addInput(path: string): void;
}

export interface JobStep<S> {
    name: string;
    /**
     * What the step's result depends on besides the steps before it, as JSON. A step with a key gets a receipt; a
     * rerun with the same keys and the same fingerprint restores the state after the last such step and starts
     * after it. A step without a key always runs, and ends the receipt chain.
     */
    key?: unknown;
    run(ctx: StepContext<S>): Promise<S>;
    /** The files the state after this step depends on: a receipt counts only while they all exist. */
    outputs?(state: S): string[];
}

export interface RunJobOptions<S> {
    kind: string;
    id?: string;
    initial: S;
    steps: JobStep<S>[];
    /** Exact input paths no step may overwrite. A folder protects its own path, not its descendants. */
    inputs?: string[];
    /** The folder for the receipts; without it every step runs. */
    receipts?: string;
    /** What the whole job depends on (the source file's size and time, a settings version), as JSON. */
    fingerprint?: unknown;
    signal?: AbortSignal;
    onProgress?: (event: ProgressEvent) => void;
    registry?: JobRegistry;
}

export class JobCancelledError extends Error {
    constructor(readonly job: string) {
        super(`Job ${job} was cancelled`);
        this.name = "JobCancelledError";
    }
}

interface Receipt {
    version: 1;
    key: string;
    state: unknown;
    at: string;
}

function receiptPath({ dir, index, name }: { dir: string; index: number; name: string }): string {
    return join(dir, `${String(index).padStart(2, "0")}-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
}

function chainKeys<S>(steps: JobStep<S>[], fingerprint: unknown): Array<string | undefined> {
    const keys: Array<string | undefined> = [];
    let open = true;

    for (const [index, step] of steps.entries()) {
        open = open && step.key !== undefined;
        keys.push(
            open
                ? createHash("sha256")
                      .update(
                          SafeJSON.stringify([
                              fingerprint ?? null,
                              steps.slice(0, index + 1).map((one) => [one.name, one.key]),
                          ])
                      )
                      .digest("hex")
                : undefined
        );
    }

    return keys;
}

function readReceipt(path: string): Receipt | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as Receipt;
        return parsed?.version === 1 && typeof parsed.key === "string" ? parsed : undefined;
    } catch (error) {
        log.debug({ error, path }, "job receipt is unreadable; the step runs again");
        return undefined;
    }
}

/** A running job: progress listeners, cancel, and `done` with the final state. */
export class Job<S> {
    readonly id: string;
    readonly kind: string;
    readonly startedAt = new Date().toISOString();
    readonly events: ProgressEvent[] = [];
    readonly steps: StepReport[] = [];
    readonly done: Promise<JobResult<S>>;
    private currentState: JobState = "running";
    private endedAt?: string;
    private error?: string;
    private readonly listeners = new Set<(event: ProgressEvent) => void>();
    private readonly controller = new AbortController();
    private readonly forwardAbort = () => this.controller.abort(this.options.signal?.reason);

    constructor(private readonly options: RunJobOptions<S>) {
        this.id = options.id ?? `${options.kind}-${randomUUID().slice(0, 8)}`;
        this.kind = options.kind;

        if (options.onProgress) {
            this.listeners.add(options.onProgress);
        }

        if (options.signal) {
            if (options.signal.aborted) {
                this.controller.abort(options.signal.reason);
            } else {
                options.signal.addEventListener("abort", this.forwardAbort, {
                    once: true,
                });
            }
        }

        options.registry?.track(this);
        this.done = this.execute();
        // A job nobody awaits must not end the process with an unhandled rejection; `done` still rejects for callers.
        this.done.catch((error: unknown) => log.debug({ error, job: this.id }, "job ended with an error"));
    }

    get state(): JobState {
        return this.currentState;
    }

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    info(): JobInfo {
        return {
            id: this.id,
            kind: this.kind,
            state: this.currentState,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            error: this.error,
            progress: this.events.at(-1),
        };
    }

    /** Every event from now on; returns the unsubscribe function. */
    on(_event: "progress", listener: (event: ProgressEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    cancel(reason = "cancelled"): void {
        this.controller.abort(new JobCancelledError(this.id));
        log.debug({ job: this.id, reason }, "job cancel requested");
    }

    emit(event: Omit<ProgressEvent, "job" | "at">): void {
        const full: ProgressEvent = { ...event, job: this.id, at: new Date().toISOString() };
        this.events.push(full);

        if (this.events.length > KEEP_EVENTS) {
            this.events.splice(0, this.events.length - KEEP_EVENTS);
        }

        for (const listener of this.listeners) {
            try {
                listener(full);
            } catch (error) {
                log.warn({ error, job: this.id }, "a job progress listener threw");
            }
        }
    }

    private async execute(): Promise<JobResult<S>> {
        // Let the caller attach listeners before the first event.
        await Promise.resolve();
        const { steps, receipts } = this.options;
        let state = this.options.initial;
        let start = 0;

        try {
            const guard = new InputGuard(this.options.inputs);
            const keys = chainKeys(steps, this.options.fingerprint);
            if (receipts) {
                // The receipt cache only saves work later; a cache that cannot be written never fails the job.
                try {
                    mkdirSync(receipts, { recursive: true });
                } catch (error) {
                    log.warn({ error, job: this.id }, "could not create receipt cache");
                }

                for (let index = steps.length - 1; index >= 0; index--) {
                    const key = keys[index];
                    const receipt = key
                        ? readReceipt(receiptPath({ dir: receipts, index, name: steps[index].name }))
                        : undefined;

                    if (receipt && receipt.key === key) {
                        const restored = receipt.state as S;
                        const missing = (steps[index].outputs?.(restored) ?? []).filter((path) => !existsSync(path));

                        if (missing.length === 0) {
                            state = restored;
                            start = index + 1;
                            break;
                        }

                        log.debug({ job: this.id, step: steps[index].name, missing }, "receipt outputs are gone");
                    }
                }

                for (let index = 0; index < start; index++) {
                    this.steps.push({ name: steps[index].name, skipped: true, ms: 0 });
                    this.emit({
                        step: steps[index].name,
                        done: index + 1,
                        total: steps.length,
                        unit: "steps",
                        message: "skipped: an earlier run's receipt",
                    });
                }
            }

            for (let index = start; index < steps.length; index++) {
                const step = steps[index];
                this.signal.throwIfAborted();
                this.emit({ step: step.name, done: index, total: steps.length, unit: "steps", message: "running" });
                const began = performance.now();
                state = await step.run({
                    job: this.id,
                    step: step.name,
                    index,
                    state,
                    signal: this.signal,
                    progress: (event) => this.emit({ step: step.name, ...event }),
                    claim: (path) => guard.claim(path),
                    addInput: (path) => guard.add(path),
                });
                this.signal.throwIfAborted();
                this.steps.push({ name: step.name, skipped: false, ms: Math.round(performance.now() - began) });
                const key = keys[index];

                if (receipts && key) {
                    const receipt: Receipt = { version: 1, key, state, at: new Date().toISOString() };
                    const path = guard.claim(receiptPath({ dir: receipts, index, name: step.name }));

                    try {
                        atomicWriteFileSync(path, SafeJSON.stringify(receipt, null, 2));
                    } catch (error) {
                        log.warn({ error, job: this.id, step: step.name }, "could not save receipt cache");
                    }
                }

                this.emit({ step: step.name, done: index + 1, total: steps.length, unit: "steps", message: "done" });
            }

            this.finish("done");
            return { state, steps: [...this.steps] };
        } catch (error) {
            const cancelled = this.signal.aborted;
            this.finish(cancelled ? "cancelled" : "failed", error);

            if (cancelled && !(error instanceof JobCancelledError)) {
                throw new JobCancelledError(this.id);
            }

            throw error;
        }
    }

    private finish(state: JobState, error?: unknown): void {
        this.options.signal?.removeEventListener("abort", this.forwardAbort);
        this.currentState = state;
        this.endedAt = new Date().toISOString();

        if (error !== undefined) {
            this.error = error instanceof Error ? error.message : String(error);
        }

        log.debug({ job: this.id, kind: this.kind, state, error: this.error }, "job ended");
    }
}

/** Starts the steps in order; `await job.done` for the final state. */
export function runJob<S>(options: RunJobOptions<S>): Job<S> {
    return new Job(options);
}

/** How many finished jobs a registry keeps. */
const KEEP_FINISHED = 50;

/** The jobs of one process (a recorder, a REPL): what a `jobs.list` call answers. */
export class JobRegistry {
    private readonly jobs = new Map<string, Job<unknown>>();

    constructor(private readonly onProgress?: (event: ProgressEvent) => void) {}

    track<S>(job: Job<S>): void {
        this.jobs.set(job.id, job as Job<unknown>);

        if (this.onProgress) {
            job.on("progress", this.onProgress);
        }

        const finished = [...this.jobs.values()].filter((one) => one.state !== "running");

        for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
            this.jobs.delete(old.id);
        }
    }

    /** A job of steps, tracked here. */
    run<S>(options: Omit<RunJobOptions<S>, "registry">): Job<S> {
        return runJob({ ...options, registry: this });
    }

    /** One piece of work as a single-step job; `work` reports with `progress`. */
    task<T>(
        kind: string,
        work: (ctx: StepContext<T | undefined>) => Promise<T>,
        options: { signal?: AbortSignal } = {}
    ): Job<T | undefined> {
        return this.run<T | undefined>({
            kind,
            initial: undefined,
            signal: options.signal,
            steps: [{ name: kind, run: (ctx) => work(ctx) }],
        });
    }

    list(): JobInfo[] {
        return [...this.jobs.values()].map((job) => job.info());
    }

    get(id: string): Job<unknown> | undefined {
        return this.jobs.get(id);
    }
}
