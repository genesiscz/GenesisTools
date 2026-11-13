// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/schedule.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * How many conversations run at once and what is retried. One adaptive limiter per `limitKey` (halve on a rate
 * limit, grow by one after five successes in a row, honour `retryAfterMs`), a global bound on open conversations,
 * the conversation as the unit of retry, blocked cells and the cost cap.
 */
import type { z } from "zod";
import { type CellRef, type ConversationRecord, runConversation } from "./conversation";
import type { Scenario } from "./document";
import type { Outcome } from "./evaluate";
import { cellKey, type RunPlan } from "./plan";
import type { RunStore } from "./store";
import {
    asSystemError,
    EvalSystemError,
    type ModelRef,
    type SystemConnection,
    type SystemErrorKind,
    type SystemInfo,
} from "./system";

/** Time for the limiter and the backoff. `testing.ts` has a controllable one. */
export interface Clock {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const SystemClock: Clock = {
    now: () => Date.now(),
    sleep: (ms, signal) =>
        new Promise((done) => {
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", finish);
                done();
            };
            const timer = setTimeout(finish, ms);
            signal?.addEventListener("abort", finish, { once: true });
            if (signal?.aborted) {
                finish();
            }
        }),
};

export interface Limiter {
    /** Runs `task` when the key has a free slot and no pause. A rate-limit `EvalSystemError` from it penalizes the key. */
    run<T>(limitKey: string, task: () => Promise<T>): Promise<T>;
    penalize(limitKey: string, retryAfterMs?: number): void;
    limits(): Record<string, number>;
}

/** Successes in a row before the limit grows by one. */
export const GrowAfter = 5;
const MaxPauseMs = 60_000;

interface KeyState {
    limit: number;
    inFlight: number;
    queue: (() => void)[];
    pausedUntil: number;
    streak: number;
    penalties: number;
    waking: boolean;
}

/**
 * An adaptive limit per key. Starts at `max`. A rate limit halves it (never below 1) and pauses the key for
 * `retryAfterMs`, or 1 s, 2 s, 4 s … up to 60 s when the system gave none. Five tasks in a row that end without an
 * error raise it by one, up to `max`. Tasks wait in FIFO order per key. Nothing is shared between processes.
 */
export function createLimiter(options: {
    max: number;
    clock: Clock;
    onChange?: (limitKey: string, limit: number) => void;
    signal?: AbortSignal;
}): Limiter {
    const max = Math.max(1, Math.floor(options.max));
    const states = new Map<string, KeyState>();
    const state = (key: string): KeyState => {
        let s = states.get(key);
        if (!s) {
            s = { limit: max, inFlight: 0, queue: [], pausedUntil: 0, streak: 0, penalties: 0, waking: false };
            states.set(key, s);
        }
        return s;
    };
    const pump = (key: string) => {
        const s = state(key);
        while (s.queue.length && s.inFlight < s.limit) {
            const wait = s.pausedUntil - options.clock.now();
            if (wait > 0) {
                if (!s.waking) {
                    s.waking = true;
                    void waitOnEvalClock(options.clock, wait, options.signal).then(() => {
                        s.waking = false;
                        pump(key);
                    });
                }
                return;
            }
            s.inFlight++;
            s.queue.shift()?.();
        }
    };
    const penalize = (key: string, retryAfterMs?: number) => {
        const s = state(key);
        s.limit = Math.max(1, Math.floor(s.limit / 2));
        s.streak = 0;
        const pause = retryAfterMs ?? Math.min(MaxPauseMs, 1000 * 2 ** s.penalties);
        s.penalties++;
        s.pausedUntil = Math.max(s.pausedUntil, options.clock.now() + pause);
        options.onChange?.(key, s.limit);
    };
    return {
        penalize,
        limits: () => Object.fromEntries([...states].map(([key, s]) => [key, s.limit])),
        async run(key, task) {
            const s = state(key);
            if (options.signal?.aborted) {
                throw new EvalSystemError("blocked", "run aborted");
            }
            await new Promise<void>((acquired, reject) => {
                const onAbort = () => {
                    const index = s.queue.indexOf(ready);
                    if (index >= 0) {
                        s.queue.splice(index, 1);
                    }
                    reject(new EvalSystemError("blocked", "run aborted"));
                };
                const ready = () => {
                    options.signal?.removeEventListener("abort", onAbort);
                    acquired();
                };
                options.signal?.addEventListener("abort", onAbort, { once: true });
                s.queue.push(ready);
                pump(key);
            });
            try {
                if (options.signal?.aborted) {
                    throw new EvalSystemError("blocked", "run aborted");
                }
                const result = await task();
                if (++s.streak >= GrowAfter) {
                    s.streak = 0;
                    s.penalties = 0;
                    if (s.limit < max) {
                        s.limit++;
                        options.onChange?.(key, s.limit);
                    }
                }
                return result;
            } catch (error) {
                if (error instanceof EvalSystemError && error.kind === "rate-limit") {
                    penalize(key, error.detail.retryAfterMs);
                } else {
                    s.streak = 0;
                }
                throw error;
            } finally {
                s.inFlight--;
                pump(key);
            }
        },
    };
}

async function waitOnEvalClock(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        signal?.addEventListener("abort", finish, { once: true });
        void clock.sleep(ms, signal).then(finish, (error) => {
            signal?.removeEventListener("abort", finish);
            reject(error);
        });
    });
}

/** A counting semaphore for open conversations. */
export function semaphore(size: number) {
    let free = size;
    const waiting: (() => void)[] = [];
    return {
        acquire: (signal?: AbortSignal) =>
            new Promise<boolean>((done) => {
                if (signal?.aborted) {
                    done(false);
                    return;
                }
                const ready = () => {
                    signal?.removeEventListener("abort", abort);
                    done(true);
                };
                const abort = () => {
                    const index = waiting.indexOf(ready);
                    if (index >= 0) {
                        waiting.splice(index, 1);
                    }
                    signal?.removeEventListener("abort", abort);
                    done(false);
                };
                if (free > 0) {
                    free--;
                    ready();
                } else {
                    signal?.addEventListener("abort", abort, { once: true });
                    waiting.push(ready);
                }
            }),
        release: () => {
            const next = waiting.shift();
            if (next) {
                next();
            } else {
                free++;
            }
        },
    };
}

export type ProgressEvent =
    | { type: "finished"; key: string; outcome: Outcome }
    | { type: "retry"; key: string; attempt: number; kind: SystemErrorKind; message: string }
    | { type: "gave-up"; key: string; attempts: number; kind: SystemErrorKind }
    | { type: "blocked"; cell: CellRef; reason: string }
    | { type: "limit"; limitKey: string; limit: number }
    | { type: "cost-limit"; spentUsd: number; maxCostUsd: number };

export interface RunOptions {
    /** Open conversations at once, and the start and top of every key's limit. */
    concurrency: number;
    /** Conversations opened per key before it is left without a result. */
    maxAttempts: number;
    keepGoing: boolean;
    /** No new conversation opens once the finished ones (this invocation and earlier ones) cost more. */
    maxCostUsd: number | null;
    signal: AbortSignal;
    clock: Clock;
    onProgress?: (event: ProgressEvent) => void;
}

export interface RunPlanInput<TResolved, TSignals, THandle> {
    runId: string;
    plan: RunPlan;
    scenarios: ReadonlyMap<string, Scenario>;
    /** Scenario id → the resolved setup. */
    setups: ReadonlyMap<string, TResolved>;
    signals: z.ZodType<TSignals>;
    connection: SystemConnection<TResolved, TSignals, THandle>;
    info: SystemInfo;
    store: RunStore;
    harness: { judge: ModelRef | null; simulator: ModelRef | null };
}

export interface RunPlanResult {
    /** Why some keys were never started; null when every key was tried. */
    stopped: { reason: "cost-limit"; spentUsd: number; maxCostUsd: number } | { reason: "aborted" } | null;
    spentUsd: number;
}

function recordCost(record: ConversationRecord): number {
    return (record.systemUsage.costUsd ?? 0) + (record.harnessUsage.costUsd ?? 0);
}

/**
 * Runs every conversation of the plan that has no final record yet. Idempotent: calling it again on the same store
 * continues the run. A conversation that returned a record is never retried, whatever its outcome; a retry is always
 * a new `open`, because the system owns the conversation's state.
 */
export async function runPlan<TResolved, TSignals, THandle>(
    input: RunPlanInput<TResolved, TSignals, THandle>,
    options: RunOptions
): Promise<RunPlanResult> {
    const { store, plan } = input;
    const done = await store.finalKeys();
    const pending = plan.conversations.filter((c) => !done.has(c.key));
    let spentUsd = (await store.finalRecords()).reduce((sum, record) => sum + recordCost(record), 0);
    const limiter = createLimiter({
        max: options.concurrency,
        clock: options.clock,
        signal: options.signal,
        onChange: (limitKey, limit) => options.onProgress?.({ type: "limit", limitKey, limit }),
    });
    const open = semaphore(Math.max(1, Math.floor(options.concurrency)));
    const blocked = new Map<string, string>();
    let stopped: RunPlanResult["stopped"] = null;
    const models = new Map(input.info.models.map((model) => [model.id, model]));

    const play = async (conversation: (typeof pending)[number]) => {
        const scenario = input.scenarios.get(conversation.cell.scenario);
        const model = models.get(conversation.cell.model);
        const setup = input.setups.get(conversation.cell.scenario);
        if (!scenario || !model || setup === undefined) {
            throw new Error(`the plan names ${conversation.key}, which the run does not hold`);
        }
        if (!(await open.acquire(options.signal))) {
            stopped = { reason: "aborted" };
            return;
        }
        let held = true;
        try {
            for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
                if (options.signal.aborted) {
                    stopped = { reason: "aborted" };
                    return;
                }
                const reason = blocked.get(cellKey(conversation.cell));
                if (reason !== undefined) {
                    await store.writeError(conversation.key, attempt, "blocked", reason);
                    return;
                }
                if (options.maxCostUsd !== null && spentUsd > options.maxCostUsd) {
                    if (!stopped) {
                        stopped = { reason: "cost-limit", spentUsd, maxCostUsd: options.maxCostUsd };
                        options.onProgress?.({ type: "cost-limit", spentUsd, maxCostUsd: options.maxCostUsd });
                    }
                    await store.writeError(
                        conversation.key,
                        attempt,
                        "cost-limit",
                        `not started: the run had cost $${spentUsd.toFixed(4)}, more than maxCostUsd $${options.maxCostUsd}`
                    );
                    return;
                }
                let record: ConversationRecord;
                try {
                    record = await runConversation(
                        {
                            key: conversation.key,
                            repeat: conversation.repeat,
                            attempt,
                            scenario,
                            cell: conversation.cell,
                            setup,
                        },
                        {
                            connection: input.connection,
                            signals: input.signals,
                            model,
                            runId: input.runId,
                            limited: (limitKey, task) => limiter.run(limitKey, task),
                            harness: input.harness,
                            putPrompt: (text) => store.putPrompt(text),
                            keepGoing: options.keepGoing,
                            signal: options.signal,
                            now: () => new Date(options.clock.now()),
                        }
                    );
                } catch (thrown) {
                    const error = asSystemError(thrown);
                    if (options.signal.aborted) {
                        stopped = { reason: "aborted" };
                        return;
                    }
                    await store.writeError(conversation.key, attempt, error.kind, error.message);
                    if (error.kind === "blocked") {
                        blocked.set(cellKey(conversation.cell), error.message);
                        options.onProgress?.({ type: "blocked", cell: conversation.cell, reason: error.message });
                        return;
                    }
                    if (attempt === options.maxAttempts) {
                        options.onProgress?.({
                            type: "gave-up",
                            key: conversation.key,
                            attempts: attempt,
                            kind: error.kind,
                        });
                        return;
                    }
                    options.onProgress?.({
                        type: "retry",
                        key: conversation.key,
                        attempt,
                        kind: error.kind,
                        message: error.message,
                    });
                    // A rate limit already paused the model's key in the limiter; other errors wait here, without a slot.
                    if (error.kind !== "rate-limit") {
                        open.release();
                        held = false;
                        await waitOnEvalClock(
                            options.clock,
                            error.detail.retryAfterMs ?? Math.min(MaxPauseMs, 1000 * 2 ** (attempt - 1)),
                            options.signal
                        );
                        if (options.signal.aborted || !(await open.acquire(options.signal))) {
                            stopped = { reason: "aborted" };
                            return;
                        }
                        held = true;
                    }
                    continue;
                }
                spentUsd += recordCost(record);
                await store.writeFinal(record);
                options.onProgress?.({ type: "finished", key: conversation.key, outcome: record.outcome });
                return;
            }
        } finally {
            if (held) {
                open.release();
            }
        }
    };

    await Promise.all(pending.map(play));
    return { stopped, spentUsd };
}
