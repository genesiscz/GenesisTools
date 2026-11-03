import { asResult } from "@genesiscz/utils/cli/result";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withTraceId } from "@genesiscz/utils/trace";

const { log } = logger.scoped("hub:server");

/** One `ai usage sessions --json` answer: the listing flags and the cache switches of `sessionRowsJson`. */
export interface SessionRowsJob {
    listing: Record<string, number>;
    fresh: boolean;
    cacheWrite: boolean;
    liveLocations: boolean;
}

export interface SessionRowsRequest extends SessionRowsJob {
    id: number;
    traceId?: string;
}

export type SessionRowsReply = { id: number; ok: true; text: string } | { id: number; ok: false; error: string };

/** The part of a `Worker` the runner uses; tests pass a fake. */
export interface RowsWorker {
    postMessage(request: SessionRowsRequest): void;
    terminate(): void;
    onmessage: ((event: MessageEvent<SessionRowsReply>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    unref?(): void;
}

/** The printed answer, byte for byte what `tools ai usage sessions --json` prints for the same job. */
export async function sessionRowsText(job: SessionRowsJob): Promise<string> {
    const { sessionRowsJson } = await import("@app/ai/lib/sessions/rows-cache");
    const { listAgentSessionRows } = await import("@app/ai/lib/sessions/agent-session-rows");
    const { listing, fresh, cacheWrite, liveLocations } = job;
    return asResult(
        await sessionRowsJson(listing, { fresh, cacheWrite, liveLocations, listRows: listAgentSessionRows })
    );
}

/**
 * How old a cached answer the server still serves at once, while one rebuild refreshes the file behind it. The poll
 * daemon rewrites the file every minute, so this is reached only when it fell behind or the server restarted cold.
 */
export const SESSION_ROWS_SERVE_STALE_MS = 10 * 60_000;

/** The cached answer for a non-fresh job, and whether it is past the age a rebuild is due at; null on a miss. */
export async function cachedSessionRowsText(job: SessionRowsJob): Promise<{ text: string; stale: boolean } | null> {
    const { cachedSessionRowsJson, SESSION_ROWS_MAX_AGE_MS } = await import("@app/ai/lib/sessions/rows-cache");
    const hit = await cachedSessionRowsJson(job.listing, {
        maxAgeMs: SESSION_ROWS_SERVE_STALE_MS,
        cacheWrite: job.cacheWrite,
        liveLocations: job.liveLocations,
    });
    if (!hit) {
        return null;
    }

    return { text: asResult(hit.answer), stale: hit.ageMs > SESSION_ROWS_MAX_AGE_MS };
}

/** A request the worker runs, inside its caller's trace id. */
export async function answerSessionRows(request: SessionRowsRequest): Promise<SessionRowsReply> {
    const { id, traceId, ...job } = request;
    try {
        return { id, ok: true, text: await withTraceId(traceId, () => sessionRowsText(job)) };
    } catch (error) {
        return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** How long the worker stays after its last answer, keeping its transcript caches warm for the next refresh. */
const IDLE_MS = 10 * 60_000;
const JOB_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the session rows rebuild on one resident worker thread, off the server's event loop: a 20 to 70 s rebuild under
 * load used to hold every other door (the inbox waited 7.4 s behind it in the 2026-10-27 bench). Identical asks while
 * one runs share it, and a caller that gives up (a deadline, a cancel) leaves the rebuild running, so its rows still
 * reach the cache file for the next ask instead of being thrown away. With no worker, the job runs inline as before. *
 * An ask the cache file answers is served from it on the event loop, never queued behind a rebuild on the worker. A
 * file past its age is still served (up to `SESSION_ROWS_SERVE_STALE_MS`) while one rebuild refreshes it: the hub's
 * minute refresh used to rebuild in the request whenever the daemon was late, 13 to 86 s each, which was 70 % of its
 * 741 s of waiting on 2026-11-02.
 */
export class SessionRowsRunner {
    private worker?: RowsWorker;
    private sequence = 0;
    private readonly pending = new Map<number, (reply: SessionRowsReply) => void>();
    private readonly flights = new Map<string, Promise<string>>();
    private idle?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly options: {
            createWorker?: () => RowsWorker;
            inline?: (job: SessionRowsJob) => Promise<string>;
            /** The cached answer of a non-fresh job; tests replace it. */
            cached?: (job: SessionRowsJob) => Promise<{ text: string; stale: boolean } | null>;
            idleMs?: number;
            jobTimeoutMs?: number;
        } = {}
    ) {}

    async run(job: SessionRowsJob, traceId?: string): Promise<string> {
        if (!job.fresh) {
            const hit = await this.cachedAnswer(job);
            if (hit) {
                if (hit.stale) {
                    this.rebuild({ ...job, fresh: true }, traceId).catch((error) => {
                        log.warn({ error, job }, "hub server: the session rows refresh behind a stale answer failed");
                    });
                }

                return hit.text;
            }
        }

        return this.rebuild(job, traceId);
    }

    private async cachedAnswer(job: SessionRowsJob): Promise<{ text: string; stale: boolean } | null> {
        try {
            return await (this.options.cached ?? cachedSessionRowsText)(job);
        } catch (error) {
            log.warn({ error, job }, "hub server: the session rows cache could not answer; rebuilding");
            return null;
        }
    }

    private rebuild(job: SessionRowsJob, traceId?: string): Promise<string> {
        const key = SafeJSON.stringify(job, { strict: true });
        const running = this.flights.get(key);
        if (running) {
            log.debug({ job }, "hub server: session rows ask joins the running rebuild");
            return running;
        }

        const flight = this.dispatch(job, traceId).finally(() => this.flights.delete(key));
        this.flights.set(key, flight);
        return flight;
    }

    stop(): void {
        clearTimeout(this.idle);
        this.worker?.terminate();
        this.worker = undefined;
        this.failPending("the session rows worker stopped");
    }

    private dispatch(job: SessionRowsJob, traceId?: string): Promise<string> {
        const worker = this.ensureWorker();
        if (!worker) {
            return (this.options.inline ?? sessionRowsText)(job);
        }

        clearTimeout(this.idle);
        const id = ++this.sequence;
        return new Promise<string>((resolve, reject) => {
            const deadline = setTimeout(() => {
                if (this.worker !== worker) {
                    return;
                }
                this.worker = undefined;
                worker.terminate();
                this.failPending("the session rows worker job timed out");
            }, this.options.jobTimeoutMs ?? JOB_TIMEOUT_MS);
            deadline.unref?.();
            this.pending.set(id, (reply) => {
                clearTimeout(deadline);
                if (reply.ok) {
                    resolve(reply.text);
                } else {
                    reject(new Error(reply.error));
                }
            });
            try {
                worker.postMessage({ id, traceId, ...job } satisfies SessionRowsRequest);
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(deadline);
                reject(error);
                this.armIdle();
            }
        });
    }

    private ensureWorker(): RowsWorker | undefined {
        if (this.worker) {
            return this.worker;
        }

        try {
            const worker: RowsWorker =
                this.options.createWorker?.() ?? new Worker(new URL("./session-rows-worker.ts", import.meta.url));
            // The worker never keeps the server alive: the server's own idle drain decides when it exits.
            worker.unref?.();
            worker.onmessage = (event: MessageEvent<SessionRowsReply>) => {
                if (this.worker !== worker) {
                    return;
                }
                const answer = this.pending.get(event.data.id);
                this.pending.delete(event.data.id);
                answer?.(event.data);
                this.armIdle();
            };
            worker.onerror = (event) => {
                if (this.worker !== worker) {
                    return;
                }
                log.warn(
                    { error: event.message },
                    "hub server: the session rows worker failed; the next ask starts one"
                );
                if (this.worker === worker) {
                    this.worker = undefined;
                }

                worker.terminate();
                this.failPending(event.message || "the session rows worker failed");
            };
            this.worker = worker;
            return worker;
        } catch (error) {
            log.warn({ error }, "hub server: no session rows worker; the rebuild runs on the event loop");
            return undefined;
        }
    }

    private failPending(error: string): void {
        const answers = [...this.pending.entries()];
        this.pending.clear();
        for (const [id, answer] of answers) {
            answer({ id, ok: false, error });
        }
    }

    private armIdle(): void {
        clearTimeout(this.idle);
        if (this.pending.size > 0) {
            return;
        }

        this.idle = setTimeout(() => {
            if (this.pending.size === 0) {
                this.worker?.terminate();
                this.worker = undefined;
            }
        }, this.options.idleMs ?? IDLE_MS);
        // An idle timer alone must not keep the server process running.
        this.idle.unref?.();
    }
}
