import { logger } from "@genesiscz/utils/logger";
import { onReleaseMemory } from "@genesiscz/utils/process/release-memory";
import { currentTraceId, withTraceId } from "@genesiscz/utils/trace";
import { type CallDoor, type Door, DoorUnsupported } from "./doors/types";
import type { CallResult } from "./protocol";

const log = logger.child({ component: "hub-server" });

/** One call of a door the worker runs, inside its caller's trace id. `parsed` is what the door's `match` returned. */
export interface DoorJob {
    op: "run";
    id: number;
    door: string;
    parsed: unknown;
    traceId?: string;
}

export type DoorWorkerMessage = DoorJob | { op: "cancel"; id: number } | { op: "release" };

export type DoorReply =
    | { id: number; ok: true; result: CallResult }
    | { id: number; ok: false; unsupported: boolean; error: string };

/** The part of a `Worker` the runner uses; tests pass a fake. */
export interface DoorWorker {
    postMessage(message: DoorWorkerMessage): void;
    terminate(): void;
    onmessage: ((event: MessageEvent<DoorReply>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    unref?(): void;
}

/** How long the worker stays after its last answer, keeping its transcript folds warm for the next refresh. */
const IDLE_MS = 15 * 60_000;
/** A job this long has hung: the worker is replaced, and its callers run their processes. */
const JOB_TIMEOUT_MS = 10 * 60_000;
/**
 * Jobs handed to the worker at once. The rest wait on the main thread, where a caller that gives up removes its job
 * before the worker ever starts it: a message already posted to a worker that is busy in a synchronous fold cannot be
 * cancelled until the fold ends.
 */
const MAX_IN_FLIGHT = 4;
/** What a caller gets when it gave up before its job finished: the shape of the worker's own cancelled answer. */
const CANCELLED: CallResult = { stdout: "", stderr: "cancelled", exit: 130 };

/** The worker's side of one job: the named door's own work, never a second dispatch. */
export async function answerDoorJob(job: DoorJob, doors: readonly Door[], signal: AbortSignal): Promise<DoorReply> {
    const door = doors.find((candidate) => candidate.kind === "call" && candidate.name === job.door);
    if (door?.kind !== "call") {
        return { id: job.id, ok: false, unsupported: true, error: `no call door named ${job.door}` };
    }

    try {
        return { id: job.id, ok: true, result: await withTraceId(job.traceId, () => door.run(job.parsed, { signal })) };
    } catch (error) {
        return {
            id: job.id,
            ok: false,
            unsupported: error instanceof DoorUnsupported,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Runs the heavy doors on one resident worker thread, off the server's event loop. A door's first ask of a large
 * session is one synchronous stretch of work (measured 2026-11-10 on a 749 MB session with 151 sub-agents: the
 * Changes fold held the loop 3.5 s, the agents tree 2.9 s, on a quiet Mac). While it ran, no other door of any window
 * was answered and no answer left the socket: at a load of 200 that stretch was 248 to 330 s, and the hub's
 * transcript pane, whose own call took 1.5 s, showed "tools call exceeded 30s". The worker keeps its own caches, so a
 * refresh stays warm.
 *
 * With no worker (it cannot start, or it failed) the job runs inline as before. A job the worker loses (it failed or
 * hung) throws `DoorUnsupported`, so the client runs the same argv as a process.
 */
export class DoorWorkerRunner {
    private worker?: DoorWorker;
    private sequence = 0;
    private readonly pending = new Map<number, (reply: DoorReply) => void>();
    /** Jobs waiting for a free place at the worker, oldest first. */
    private readonly queue: { id: number; start: () => void; fail: (error: string) => void }[] = [];
    private idle?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly options: {
            createWorker?: () => DoorWorker;
            idleMs?: number;
            jobTimeoutMs?: number;
            maxInFlight?: number;
        } = {}
    ) {}

    /** Jobs the worker has not answered yet. */
    get running(): number {
        return this.pending.size;
    }

    /** Jobs that wait on the main thread for a free place at the worker. */
    get queued(): number {
        return this.queue.length;
    }

    async run(input: {
        door: string;
        parsed: unknown;
        signal: AbortSignal;
        traceId?: string;
        inline: () => Promise<CallResult>;
    }): Promise<CallResult> {
        if (input.signal.aborted) {
            return CANCELLED;
        }

        const worker = this.ensureWorker();
        if (!worker) {
            return input.inline();
        }

        clearTimeout(this.idle);
        const id = ++this.sequence;
        const reply = await new Promise<DoorReply>((resolve) => {
            const dispatch = (): void => {
                const deadline = setTimeout(() => {
                    if (this.worker !== worker) {
                        return;
                    }

                    log.warn({ door: input.door }, "hub server: a door worker job hung; replacing the worker");
                    this.discard(worker, "the door worker job timed out");
                }, this.options.jobTimeoutMs ?? JOB_TIMEOUT_MS);
                deadline.unref?.();
                this.pending.set(id, (answer) => {
                    clearTimeout(deadline);
                    resolve(answer);
                });
                try {
                    worker.postMessage({
                        op: "run",
                        id,
                        door: input.door,
                        parsed: input.parsed,
                        traceId: input.traceId,
                    });
                } catch (error) {
                    this.pending.get(id)?.({
                        id,
                        ok: false,
                        unsupported: true,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    this.pending.delete(id);
                }
            };
            const cancelled: DoorReply = { id, ok: true, result: CANCELLED };
            // The caller is answered at once. A job the worker already holds keeps its place until the worker
            // answers or the watchdog replaces it, so the in-flight cap still bounds the work.
            const cancel = (): void => {
                const waiting = this.queue.findIndex((entry) => entry.id === id);
                if (waiting >= 0) {
                    this.queue.splice(waiting, 1);
                } else if (this.worker === worker && this.pending.has(id)) {
                    worker.postMessage({ op: "cancel", id });
                }

                resolve(cancelled);
            };
            input.signal.addEventListener("abort", cancel, { once: true });
            if (this.pending.size < (this.options.maxInFlight ?? MAX_IN_FLIGHT)) {
                dispatch();
            } else {
                this.queue.push({
                    id,
                    start: dispatch,
                    fail: (error) => resolve({ id, ok: false, unsupported: true, error }),
                });
            }
        });
        this.armIdle();
        if (reply.ok) {
            return reply.result;
        }

        if (reply.unsupported) {
            throw new DoorUnsupported(reply.error);
        }

        throw new Error(reply.error);
    }

    /**
     * Frees what the worker holds: an idle worker ends (its whole heap goes back), a busy one drops its caches when
     * its jobs give the thread back.
     */
    release(): void {
        if (!this.worker) {
            return;
        }

        if (this.pending.size === 0) {
            this.stop();
            return;
        }

        this.worker.postMessage({ op: "release" });
    }

    stop(): void {
        clearTimeout(this.idle);
        this.discard(this.worker, "the door worker stopped");
    }

    private ensureWorker(): DoorWorker | undefined {
        if (this.worker) {
            return this.worker;
        }

        try {
            const worker: DoorWorker =
                this.options.createWorker?.() ?? new Worker(new URL("./door-worker.ts", import.meta.url));
            // The worker never keeps the server alive: the server's own idle drain decides when it exits.
            worker.unref?.();
            worker.onmessage = (event: MessageEvent<DoorReply>) => {
                if (this.worker !== worker) {
                    return;
                }

                const answer = this.pending.get(event.data.id);
                this.pending.delete(event.data.id);
                answer?.(event.data);
                this.startQueued();
            };
            worker.onerror = (event) => {
                if (this.worker !== worker) {
                    return;
                }

                log.warn({ error: event.message }, "hub server: the door worker failed; the next ask starts one");
                this.discard(worker, event.message || "the door worker failed");
            };
            this.worker = worker;
            return worker;
        } catch (error) {
            log.warn({ error }, "hub server: no door worker; heavy doors run on the event loop");
            return undefined;
        }
    }

    /** Drops the worker and ends it: the next ask starts one, and the callers of its lost jobs run their processes. */
    private discard(worker: DoorWorker | undefined, reason: string): void {
        this.worker = undefined;
        worker?.terminate();
        this.failPending(reason);
    }

    /** The callers of a lost job, and of every job still waiting for a place, run their processes. */
    private failPending(error: string): void {
        const answers = [...this.pending.entries()];
        const waiting = this.queue.splice(0);
        this.pending.clear();
        for (const [id, answer] of answers) {
            answer({ id, ok: false, unsupported: true, error });
        }

        for (const entry of waiting) {
            entry.fail(error);
        }
    }

    /** Hands waiting jobs to the worker while it has free places. */
    private startQueued(): void {
        while (this.queue.length > 0 && this.pending.size < (this.options.maxInFlight ?? MAX_IN_FLIGHT)) {
            this.queue.shift()?.start();
        }
    }

    private armIdle(): void {
        clearTimeout(this.idle);
        if (this.pending.size > 0 || this.queue.length > 0) {
            return;
        }

        this.idle = setTimeout(() => {
            if (this.pending.size === 0) {
                this.discard(this.worker, "the door worker went idle");
            }
        }, this.options.idleMs ?? IDLE_MS);
        // An idle timer alone must not keep the server process running.
        this.idle.unref?.();
    }
}

/**
 * A door worker per lane: the session doors of the selected session (Changes, sub-agents) share one, and the agents
 * list has its own, so a refresh of the list never waits behind a fold of a large session (the agents tree waited
 * 4.5 s behind a Changes fold of a 749 MB session, 2026-11-10). Each lane's caches are released with the server's own
 * (`releaseMemory`).
 */
export type DoorLane = "session" | "agents";

const lanes = new Map<DoorLane, DoorWorkerRunner>();

export function laneRunner(lane: DoorLane): DoorWorkerRunner {
    let runner = lanes.get(lane);
    if (!runner) {
        const created = new DoorWorkerRunner();
        onReleaseMemory(`hub server door worker (${lane})`, () => created.release());
        lanes.set(lane, created);
        runner = created;
    }

    return runner;
}

/**
 * The same door, with its work on the door worker. On the worker's own thread the door runs as written, so the
 * worker can find it in the door list by its name and never dispatches a second time. A door goes here when its
 * first ask of a large session holds the event loop for more than about 100 ms
 * (`bun scripts/benchmarks/hub/big-session.ts` prints `<call>.cold.stallMs` for each).
 */
export function offEventLoop<P>(
    door: CallDoor<P>,
    runner: () => DoorWorkerRunner = () => laneRunner("session")
): CallDoor<P> {
    return {
        ...door,
        run(parsed, ctx) {
            if (!Bun.isMainThread) {
                return door.run(parsed, ctx);
            }

            return runner().run({
                door: door.name,
                parsed,
                signal: ctx.signal,
                traceId: currentTraceId(),
                inline: () => door.run(parsed, ctx),
            });
        },
    };
}
