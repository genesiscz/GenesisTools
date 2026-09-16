import { logger } from "@genesiscz/utils/logger";

/**
 * A pool of on-demand workers over a claim function.
 *
 * The pool never polls hot. A worker that finds nothing to claim parks on a promise and is
 * woken by `kick()`; a parked worker that stays idle for `idleTeardownMs` retires, down to `min`
 * resident workers (default 0). Wake sources are the caller's business: an in-process event
 * (`emitter.on("created", () => pool.kick())`), a file watcher, or the built-in fallback poll,
 * which kicks every `pollMs` so a missed event is healed within one interval rather than never.
 *
 * Scaling is claim-driven, so a burst is safe without a pending count: with the default
 * `spawnPolicy: "burst"`, every successful claim wakes or spawns one more worker
 * (up to `max`), which claims the next item and repeats. The ramp is bounded by `max` and stops
 * by itself when a claim returns null. `pendingHint` lets a kick spawn several workers at once
 * when the caller can count pending items cheaply.
 *
 * Inspired by tinypool/piscina (`minThreads`/`idleTimeout` retire idle threads), poolifier's
 * dynamic pool (spawn only when no worker is idle) and p-queue's `_tryToStartAnother` cascade.
 */
export interface WorkerPoolOptions<T> {
    /** Appears in log lines and worker ids. */
    name: string;
    /** Upper bound on live workers. A function is re-read on every scale decision, so a config change applies live. */
    max: number | (() => number);
    /** Workers kept alive while idle. Default 0: the pool costs one fallback poll per `pollMs` when idle. */
    min?: number;
    /** Return the next unit of work, or null when there is none. Runs on a worker, one at a time per worker. */
    claim: (ctx: WorkerContext) => Promise<T | null> | T | null;
    /** Run one unit of work. A throw is reported through `onError` and the worker carries on. */
    run: (item: T, ctx: WorkerContext) => Promise<void>;
    /** How long a parked worker waits for a kick before it retires. Default 30_000. */
    idleTeardownMs?: number;
    /** Fallback kick cadence when no external wake source fires. 0 disables it. Default 2_000. */
    pollMs?: number;
    /** "burst": each successful claim wakes or spawns another worker; "one": only kicks spawn. Default "burst". */
    spawnPolicy?: "burst" | "one";
    /** Cheap count of pending items; a kick wakes or spawns up to that many workers. Default: one. */
    pendingHint?: () => number;
    /** Delay before a worker claims again after `claim` threw. Default 1_000. */
    claimErrorBackoffMs?: number;
    /**
     * How long `stop()` waits for running jobs before it gives up on them. The abort signal is
     * raised first either way, so a handler that honours it finishes early. Default 30_000.
     * Taken from piscina's `close()`, which races the drain against a timeout and destroys anyway:
     * without it one handler that ignores its signal hangs shutdown for good.
     */
    drainTimeoutMs?: number;
    onError?: (error: unknown, ctx: WorkerContext & { phase: "claim" | "run" }) => void;
}

export interface WorkerContext {
    workerId: string;
    /** Aborted by `stop()`. */
    signal: AbortSignal;
}

export interface WorkerPoolStats {
    workers: number;
    busy: number;
    idle: number;
    kicks: number;
    spawned: number;
    retired: number;
    claims: number;
    claimed: number;
    /**
     * Where the kicks came from. A pool whose `timer` count dominates `notify` is being driven by
     * its fallback poll, which means the in-process wake is not wired to the code that enqueues.
     * That is the failure this breakdown exists to make visible; the counts are otherwise equal.
     */
    wakes: { notify: number; timer: number; cascade: number };
    /** Jobs still running when `stop()` gave up waiting. Non-zero means a handler ignored its signal. */
    abandoned: number;
}

interface ParkedWorker {
    wake: (woken: boolean) => void;
}

const DEFAULT_IDLE_TEARDOWN_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_CLAIM_ERROR_BACKOFF_MS = 1_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** A timer that never holds the process open, so a pending drain deadline cannot delay exit. */
function sleepUnref(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

export class WorkerPool<T> {
    private readonly parked = new Set<ParkedWorker>();
    private readonly loops = new Set<Promise<void>>();
    private abort = new AbortController();
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private stopping = false;
    private nextWorkerId = 0;
    /** Bumped by every kick; a worker that saw an older value before a null claim re-claims instead of parking. */
    private kickSeq = 0;
    /** True between a notify and the microtask that acts on it, so a burst of notifies is one decision. */
    private kickPending = false;
    private readonly stats: WorkerPoolStats = {
        workers: 0,
        busy: 0,
        idle: 0,
        kicks: 0,
        spawned: 0,
        retired: 0,
        claims: 0,
        claimed: 0,
        wakes: { notify: 0, timer: 0, cascade: 0 },
        abandoned: 0,
    };

    constructor(private readonly opts: WorkerPoolOptions<T>) {}

    /** Spawns `min` workers, arms the fallback poll and kicks once so pre-existing work is claimed. */
    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        this.stopping = false;
        this.abort = new AbortController();
        const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;

        if (pollMs > 0) {
            this.pollTimer = setInterval(() => this.kick("timer"), pollMs);
            this.pollTimer.unref();
        }

        for (let i = 0; i < (this.opts.min ?? 0); i++) {
            this.spawn();
        }

        this.kick();
    }

    /** Wakes every parked worker with "stop", aborts the signal and waits for every loop to finish. */
    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }

        this.stopping = true;

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        this.abort.abort();

        for (const worker of this.parked) {
            worker.wake(false);
        }

        const drained = await Promise.race([
            Promise.allSettled(this.loops).then(() => true),
            sleepUnref(this.opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS).then(() => false),
        ]);

        if (!drained) {
            this.stats.abandoned = this.stats.busy;
            logger.warn(
                { pool: this.opts.name, busy: this.stats.busy },
                "worker pool drain timed out; jobs were left running with an aborted signal"
            );
        }

        this.loops.clear();
        this.started = false;
    }

    /**
     * Wake a parked worker, or spawn one when none is parked and the pool is below `max`.
     *
     * Coalesced to one wake per microtask: enqueueing 50 rows in a loop raises 50 notifies but
     * runs the scale decision once, so a burst does not pay 50 pending-count reads to learn the
     * same thing. `wakes` counts the notifies, `kicks` counts the decisions.
     */
    kick(source: "notify" | "timer" | "cascade" = "notify"): void {
        if (!this.started || this.stopping) {
            return;
        }

        this.stats.wakes[source]++;

        if (this.kickPending) {
            return;
        }

        this.kickPending = true;
        queueMicrotask(() => {
            this.kickPending = false;

            if (this.started && !this.stopping) {
                this.scale();
            }
        });
    }

    private scale(): void {
        this.stats.kicks++;
        this.kickSeq++;
        const max = this.currentMax();
        const hint = this.opts.pendingHint?.() ?? 1;
        // `want` is how many workers should be engaged in total: parked ones are woken first, then
        // the pool is topped up to `want` (never above `max`). Busy workers count as engaged, since
        // they claim again as soon as their item finishes.
        const want = Math.max(1, Math.min(hint, max));
        let woken = 0;

        for (const worker of this.parked) {
            if (woken >= want) {
                break;
            }

            worker.wake(true);
            woken++;
        }

        while (this.stats.workers < want) {
            this.spawn();
        }

        if (this.stats.workers === 0 && max <= 0) {
            logger.warn({ pool: this.opts.name }, "worker pool kicked with max 0, nothing can run");
        }
    }

    getStats(): WorkerPoolStats {
        return { ...this.stats, idle: this.parked.size };
    }

    private currentMax(): number {
        const max = typeof this.opts.max === "function" ? this.opts.max() : this.opts.max;

        return Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
    }

    private spawn(): void {
        const workerId = `${this.opts.name}-${this.nextWorkerId++}`;
        this.stats.workers++;
        this.stats.spawned++;
        logger.debug({ pool: this.opts.name, workerId, workers: this.stats.workers }, "worker pool spawned worker");
        const loop = this.workerLoop(workerId).finally(() => {
            this.loops.delete(loop);
        });
        this.loops.add(loop);
    }

    private async workerLoop(workerId: string): Promise<void> {
        const ctx: WorkerContext = { workerId, signal: this.abort.signal };

        try {
            while (!this.stopping) {
                let item: T | null = null;
                let claimFailed = false;
                const seenKick = this.kickSeq;
                this.stats.claims++;

                try {
                    item = await this.opts.claim(ctx);
                } catch (error) {
                    claimFailed = true;
                    this.report(error, ctx, "claim");
                }

                if (this.stopping) {
                    return;
                }

                if (item === null && !claimFailed && seenKick !== this.kickSeq) {
                    // A kick landed while this claim was in flight; its null answer is stale.
                    continue;
                }

                if (item !== null) {
                    this.stats.claimed++;

                    if ((this.opts.spawnPolicy ?? "burst") === "burst") {
                        // There may be more behind this one: hand the next claim to another worker
                        // while this one runs. The cascade stops as soon as a claim returns null.
                        this.stats.wakes.cascade++;
                        this.wakeOrSpawnOne();
                    }

                    this.stats.busy++;

                    try {
                        await this.opts.run(item, ctx);
                    } catch (error) {
                        this.report(error, ctx, "run");
                    } finally {
                        this.stats.busy--;
                    }

                    continue;
                }

                if (claimFailed) {
                    const woken = await this.park(this.opts.claimErrorBackoffMs ?? DEFAULT_CLAIM_ERROR_BACKOFF_MS);

                    if (!woken && this.stopping) {
                        return;
                    }

                    continue;
                }

                const woken = await this.park(this.opts.idleTeardownMs ?? DEFAULT_IDLE_TEARDOWN_MS);

                if (!woken && (this.stopping || this.stats.workers > (this.opts.min ?? 0))) {
                    return;
                }
            }
        } finally {
            this.stats.workers--;
            this.stats.retired++;
            logger.debug({ pool: this.opts.name, workerId, workers: this.stats.workers }, "worker pool retired worker");
        }
    }

    private wakeOrSpawnOne(): void {
        if (this.stopping) {
            return;
        }

        if (this.opts.pendingHint && this.opts.pendingHint() <= 0) {
            return;
        }

        for (const worker of this.parked) {
            worker.wake(true);
            return;
        }

        if (this.stats.workers < this.currentMax()) {
            this.spawn();
        }
    }

    /** Resolves true when kicked, false when the timeout elapsed or the pool is stopping. */
    private park(timeoutMs: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => finish(false), timeoutMs);
            timer.unref();
            const worker: ParkedWorker = {
                wake: (woken) => finish(woken),
            };
            const finish = (woken: boolean) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                this.parked.delete(worker);
                resolve(woken);
            };

            if (this.stopping) {
                finish(false);
                return;
            }

            this.parked.add(worker);
        });
    }

    private report(error: unknown, ctx: WorkerContext, phase: "claim" | "run"): void {
        if (this.opts.onError) {
            this.opts.onError(error, { ...ctx, phase });
            return;
        }

        logger.warn({ err: error, pool: this.opts.name, workerId: ctx.workerId, phase }, "worker pool step failed");
    }
}
