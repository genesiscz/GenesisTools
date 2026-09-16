import { EventEmitter } from "node:events";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeConfigShape } from "@app/youtube/lib/config.types";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { withJobActivity } from "@app/youtube/lib/job-activity";
import { JOB_STAGES, type JobEvent, type JobStage, type PipelineJob } from "@app/youtube/lib/jobs.types";
import type {
    EnqueuePipelineJobInput,
    EnqueuePipelineResult,
    JobEventHandler,
    ListPipelineJobsOpts,
    PipelineDeps,
    StageHandlerCtx,
} from "@app/youtube/lib/pipeline.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import { logger } from "@genesiscz/utils/logger";
import { WorkerPool, type WorkerPoolStats, watchSqliteChanges } from "@genesiscz/utils/workers";

/**
 * A job handed from the dispatcher to a worker, with the stage it was claimed for. A multi-stage
 * job is re-claimed once per stage, so the stage is not derivable from the row alone.
 */
interface ClaimedJob {
    job: PipelineJob;
    stage: JobStage;
}

/**
 * Later stages first. A job already part-way through the pipeline finishes before a new one starts,
 * which keeps the queue draining rather than fanning out and holding everything half-done.
 */
const CLAIM_ORDER: readonly JobStage[] = [...JOB_STAGES].reverse();

/** How long the cached config limits may be reused. Re-read lazily, only while work is flowing. */
const LIMITS_TTL_MS = 30_000;

/** What `workerStats()` answers before `start()` and after `stop()`. */
const IDLE_STATS: WorkerPoolStats = {
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

interface StageLimits {
    /** Total live workers allowed, whatever stage they are on. */
    max: number;
    /** Per-stage ceiling, so one stage cannot take the whole pool. */
    capacity: (stage: JobStage) => number;
    idleTeardownMs: number;
    pollMs: number;
    spawnPolicy: "burst" | "one";
    readAt: number;
}

export class Pipeline {
    private readonly emitter = new EventEmitter();
    private readonly jobAborts = new Map<number, AbortController>();
    private globalConcurrencyOverride: number | null = null;
    private running = false;
    private pool: WorkerPool<ClaimedJob> | null = null;
    private stopDbWatch: (() => void) | null = null;
    /** Live jobs per stage, so the per-stage concurrency caps still hold inside one shared pool. */
    private readonly inFlight = new Map<JobStage, number>();
    private limits: StageLimits | null = null;
    private limitsRefresh: Promise<void> | null = null;
    /**
     * The stage the last claim succeeded on, or null after a claim came back empty.
     *
     * While a queue is draining the next row is almost always on the same stage, so a worker
     * retries it directly and skips the pending-count read: one statement per job instead of two.
     * A null claim clears it, so an IDLE pool never pays the speculative UPDATE and reads the
     * cheaper count instead. That asymmetry is the point: idle is the common case.
     */
    private hotStage: JobStage | null = null;

    constructor(
        private readonly db: YoutubeDatabase,
        private readonly config: YoutubeConfig,
        private readonly deps: PipelineDeps
    ) {}

    on<E extends JobEvent["type"]>(event: E, handler: JobEventHandler<E>): () => void {
        const wrapped = handler as (event: JobEvent) => void;
        this.emitter.on(event, wrapped);

        return () => this.emitter.off(event, wrapped);
    }

    enqueue(input: EnqueuePipelineJobInput): EnqueuePipelineResult {
        if (!input.force) {
            const artifact = this.tryArtifactShortCircuit(input);

            if (artifact) {
                return artifact;
            }
        }

        const { job, reused } = this.db.enqueueJob(input);
        // Counted within the job's own owner, since this number is handed straight
        // back to whoever enqueued it. An unowned job (CLI/operator) has no owner to
        // narrow by and keeps the global position.
        const queuePosition = this.db.getJobQueuePosition(job.id, { userId: job.userId ?? undefined });
        logger.info(
            {
                jobId: job.id,
                targetKind: job.targetKind,
                target: job.target,
                stages: job.stages,
                parentJobId: job.parentJobId,
                reused,
                queuePosition,
                priority: job.priority,
            },
            reused ? "youtube pipeline job reused" : "youtube pipeline job enqueued"
        );

        if (!reused) {
            this.emit({ type: "job:created", job });
        }

        // In-process wake. A worker starts on this row within a tick instead of waiting for the
        // fallback poll, which is what makes a long poll interval affordable.
        this.pool?.kick();

        return { job, reused, queuePosition };
    }

    getJob(id: number): PipelineJob | null {
        return this.db.getJob(id);
    }

    listJobs(opts: ListPipelineJobsOpts = {}): PipelineJob[] {
        return this.db.listJobs(opts);
    }

    cancelJob(id: number): void {
        this.db.cancelJob(id);
        const controller = this.jobAborts.get(id);

        if (controller) {
            controller.abort(new Error(`job ${id} cancelled`));
        }

        this.emit({ type: "job:cancelled", jobId: id });
    }

    setGlobalConcurrencyOverride(value: number | null): void {
        this.globalConcurrencyOverride = value === null ? null : Math.max(1, Math.floor(value));
    }

    async start(): Promise<void> {
        if (this.running) {
            return;
        }

        this.running = true;
        this.hotStage = null;
        const requeued = this.db.markInterruptedJobsForRequeue();
        const limits = await this.readLimits();
        logger.info({ requeued, max: limits.max, pollMs: limits.pollMs }, "youtube pipeline starting");

        this.pool = new WorkerPool<ClaimedJob>({
            name: this.deps.workerIdPrefix ?? "youtube",
            max: () => this.currentMax(),
            claim: (ctx) => this.claimNext(ctx.workerId),
            run: (claimed, ctx) => this.runJob(claimed.job, claimed.stage, ctx.signal),
            pendingHint: () => this.pendingHint(),
            spawnPolicy: limits.spawnPolicy,
            idleTeardownMs: limits.idleTeardownMs,
            pollMs: this.deps.pollMs ?? limits.pollMs,
            onError: (error, ctx) => {
                logger.warn({ err: error, workerId: ctx.workerId, phase: ctx.phase }, "youtube pipeline worker failed");
            },
        });
        this.pool.start();
        // A `tools youtube queue add` in another process writes the row and exits, with nothing to
        // raise an in-process event. This watches the database file instead, so a CLI enqueue is
        // picked up in milliseconds rather than waiting out the fallback poll.
        this.stopDbWatch = watchSqliteChanges(this.db.getDb(), () => this.pool?.kick());
    }

    async stop(): Promise<void> {
        if (this.running) {
            logger.info({ workers: this.pool?.getStats().workers ?? 0 }, "youtube pipeline stopping");
            this.running = false;
            this.stopDbWatch?.();
            this.stopDbWatch = null;
            await this.pool?.stop();
            this.pool = null;
            this.inFlight.clear();
        }

        this.hotStage = null;
    }

    /** Live pool counters. The idle benchmark reads this; it is also the first thing to look at
     *  when jobs sit pending, since `workers` at `max` with `idle` at 0 means capacity, not a stall. */
    workerStats(): WorkerPoolStats {
        return this.pool?.getStats() ?? IDLE_STATS;
    }

    /**
     * One read of the pending set, then at most one claim against a stage that has both a row and
     * free capacity. Returns null when there is nothing this worker may take, which parks it.
     *
     * Synchronous against the database on purpose: `bun:sqlite` calls do not yield, so two workers
     * can never interleave between the count and the claim, and `claimNextJob`'s conditional UPDATE
     * is the real guard against a double claim anyway.
     */
    private async claimNext(workerId: string): Promise<ClaimedJob | null> {
        if (!this.running) {
            return null;
        }

        const limits = await this.readLimits();

        if (!this.running) {
            return null;
        }

        const hot = this.hotStage;

        if (hot !== null && this.inFlightFor(hot) < limits.capacity(hot)) {
            const job = this.db.claimNextJob(workerId, { stage: hot });

            if (job) {
                this.inFlight.set(hot, this.inFlightFor(hot) + 1);

                return { job, stage: hot };
            }
        }

        const pending = this.db.countPendingJobsByStage();

        if (pending.size === 0) {
            this.hotStage = null;

            return null;
        }

        for (const stage of CLAIM_ORDER) {
            if (!pending.has(stage) || this.inFlightFor(stage) >= limits.capacity(stage)) {
                continue;
            }

            const job = this.db.claimNextJob(workerId, { stage });

            if (job) {
                this.inFlight.set(stage, this.inFlightFor(stage) + 1);
                this.hotStage = stage;

                return { job, stage };
            }
        }

        this.hotStage = null;

        return null;
    }

    /** How many workers a kick should engage: pending rows, narrowed by what each stage may still run. */
    private pendingHint(): number {
        if (!this.running || !this.limits) {
            return 1;
        }

        let want = 0;

        for (const [stage, count] of this.db.countPendingJobsByStage()) {
            want += Math.min(count, Math.max(0, this.limits.capacity(stage) - this.inFlightFor(stage)));
        }

        return want;
    }

    private inFlightFor(stage: JobStage): number {
        return this.inFlight.get(stage) ?? 0;
    }

    private currentMax(): number {
        if (this.globalConcurrencyOverride !== null) {
            return this.globalConcurrencyOverride;
        }

        return this.limits?.max ?? 1;
    }

    /**
     * Cached config limits, re-read at most every `LIMITS_TTL_MS` and only while claims are running.
     * Worker counts used to be read once in `start()`, so a `PATCH /api/v1/config` had no effect
     * until the server restarted; the pool asks for its ceiling on every scale decision instead.
     */
    private async readLimits(): Promise<StageLimits> {
        if (this.limits && Date.now() - this.limits.readAt < LIMITS_TTL_MS) {
            return this.limits;
        }

        this.limitsRefresh ??= this.refreshLimits().finally(() => {
            this.limitsRefresh = null;
        });
        await this.limitsRefresh;

        return this.limits as StageLimits;
    }

    private async refreshLimits(): Promise<void> {
        const all = await this.config.getAll();
        const { concurrency, workers } = all;
        const capacityByStage = new Map<JobStage, number>();

        for (const stage of JOB_STAGES) {
            capacityByStage.set(stage, stageCapacityFrom(stage, concurrency));
        }

        this.limits = {
            max: Math.max(1, workers.max),
            capacity: (stage) => this.globalConcurrencyOverride ?? capacityByStage.get(stage) ?? 1,
            idleTeardownMs: workers.idleTeardownMs,
            pollMs: workers.pollMs,
            spawnPolicy: workers.spawnPolicy,
            readAt: Date.now(),
        };
    }

    private async runJob(job: PipelineJob, claimedStage: JobStage, signal: AbortSignal): Promise<void> {
        logger.info(
            { jobId: job.id, targetKind: job.targetKind, target: job.target, claimedStage, stages: job.stages },
            "youtube pipeline job started"
        );
        this.emit({ type: "job:started", job });

        const jobController = new AbortController();
        this.jobAborts.set(job.id, jobController);
        const mergedSignal = AbortSignal.any([signal, jobController.signal]);

        try {
            if (!this.running || mergedSignal.aborted) {
                return;
            }

            const handler = this.deps.handlers[claimedStage];

            if (!handler) {
                throw new Error(`No handler registered for stage ${claimedStage}`);
            }

            const claimedIndex = job.stages.indexOf(claimedStage);
            const baseProgress = claimedIndex === -1 ? 0 : claimedIndex / job.stages.length;

            logger.debug(
                { jobId: job.id, stage: claimedStage, targetKind: job.targetKind, target: job.target },
                "youtube pipeline stage started"
            );
            this.db.updateJob(job.id, {
                currentStage: claimedStage,
                progress: baseProgress,
                progressMessage: null,
            });
            this.emit({ type: "stage:started", jobId: job.id, stage: claimedStage });

            const ctx: StageHandlerCtx = {
                job: this.db.getJob(job.id) ?? job,
                signal: mergedSignal,
                onProgress: (progress, message) => {
                    this.db.updateJob(job.id, { progress, progressMessage: message ?? null });
                    this.emit({ type: "stage:progress", jobId: job.id, stage: claimedStage, progress, message });
                },
            };

            await withJobActivity(
                {
                    jobId: job.id,
                    stage: claimedStage,
                    db: this.db,
                    userId: job.userId,
                    emit: this.emitExternal.bind(this),
                },
                () => handler(ctx)
            );
            logger.debug(
                { jobId: job.id, stage: claimedStage, targetKind: job.targetKind, target: job.target },
                "youtube pipeline stage completed"
            );
            this.emit({ type: "stage:completed", jobId: job.id, stage: claimedStage });

            if (jobController.signal.aborted) {
                logger.info(
                    { jobId: job.id, targetKind: job.targetKind, target: job.target },
                    "youtube pipeline job stopped (cancelled)"
                );
                return;
            }

            const remaining = remainingStagesAfter(job, claimedStage);

            if (remaining.length > 0) {
                this.db.advanceJobToNextStage(job.id, remaining);
                logger.debug(
                    { jobId: job.id, completed: claimedStage, next: remaining[0] },
                    "youtube pipeline job advanced to next stage"
                );
                // The row went back to pending under a different stage. Wake a worker for it now
                // rather than leaving it until the fallback poll.
                this.pool?.kick();
                return;
            }

            this.db.updateJob(job.id, {
                status: "completed",
                completedAt: new Date().toISOString(),
                progress: 1,
                progressMessage: null,
                currentStage: null,
            });
            const completed = this.db.getJob(job.id) ?? job;
            logger.info(
                { jobId: completed.id, targetKind: completed.targetKind, target: completed.target },
                "youtube pipeline job completed"
            );
            this.emit({ type: "job:completed", job: completed });
        } catch (error) {
            if (jobController.signal.aborted) {
                logger.info(
                    { jobId: job.id, target: job.target, target_kind: job.targetKind },
                    "youtube pipeline job stopped mid-stage (cancelled)"
                );
                return;
            }

            const message = error instanceof Error ? error.message : String(error);
            this.db.updateJob(job.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
            const holdId = job.params && typeof job.params.holdId === "number" ? job.params.holdId : null;

            if (holdId !== null) {
                try {
                    this.db.releaseHold(holdId);
                } catch (releaseError) {
                    logger.warn({ err: releaseError, jobId: job.id, holdId }, "youtube pipeline: release hold failed");
                }
            }

            const failed = this.db.getJob(job.id) ?? job;
            logger.error(
                { jobId: failed.id, targetKind: failed.targetKind, target: failed.target, error: message },
                "youtube pipeline job failed"
            );
            this.emit({ type: "job:failed", job: failed, error: message });
        } finally {
            this.jobAborts.delete(job.id);
            this.inFlight.set(claimedStage, Math.max(0, this.inFlightFor(claimedStage) - 1));
        }
    }

    private emit(event: JobEvent): void {
        this.emitter.emit(event.type, event);
    }

    /**
     * Skip enqueue when the requested fetch work is already satisfied locally
     * (comments / captions). Channel ensure handles discover sync itself.
     */
    private tryArtifactShortCircuit(input: EnqueuePipelineJobInput): EnqueuePipelineResult | null {
        if (input.targetKind !== "video") {
            return null;
        }

        const videoId = input.target as VideoId;
        const work = input.stages.filter((stage) => stage !== "metadata");

        if (work.length === 1 && work[0] === "comments" && this.db.getComments(videoId).length > 0) {
            logger.info({ videoId, stages: input.stages }, "youtube pipeline skip enqueue: comments exist");
            return { job: null, reused: true, queuePosition: null, skipped: "artifact" };
        }

        if (work.length === 1 && work[0] === "captions" && this.db.getTranscript(videoId)) {
            logger.info({ videoId, stages: input.stages }, "youtube pipeline skip enqueue: transcript exists");
            return { job: null, reused: true, queuePosition: null, skipped: "artifact" };
        }

        return null;
    }

    /** Emit pipeline lifecycle events for a job that runs OUTSIDE the queue worker
     *  (e.g. POST /summary which executes synchronously inside the request handler).
     *  Keeps the WS event stream + UI progress bar in sync with synchronous routes. */
    emitExternal(event: JobEvent): void {
        this.emitter.emit(event.type, event);
    }
}

/** The per-stage ceiling, from the user-facing `concurrency` block. */
function stageCapacityFrom(stage: JobStage, concurrency: YoutubeConfigShape["concurrency"]): number {
    switch (stage) {
        case "discover":
        case "metadata":
        case "comments":
        case "captions":
        case "audio":
        case "video":
            return Math.max(1, concurrency.download);
        case "transcribe":
            return Math.max(1, Math.max(concurrency.localTranscribe, concurrency.cloudTranscribe));
        case "qaIndex":
        case "summarize":
        case "qa":
        case "reportSynthesize":
            return Math.max(1, concurrency.summarize);
    }
}

function remainingStagesAfter(job: PipelineJob, claimedStage: JobStage): JobStage[] {
    if (job.targetKind === "channel" && claimedStage === "discover") {
        return [];
    }

    const idx = job.stages.indexOf(claimedStage);

    if (idx === -1) {
        return [];
    }

    return job.stages.slice(idx + 1);
}
