import { EventEmitter } from "node:events";
import logger from "@app/logger";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { withJobActivity } from "@app/youtube/lib/job-activity";
import type { JobEvent, JobStage, PipelineJob } from "@app/youtube/lib/jobs.types";
import type {
    EnqueuePipelineJobInput,
    JobEventHandler,
    ListPipelineJobsOpts,
    PipelineDeps,
    StageHandlerCtx,
} from "@app/youtube/lib/pipeline.types";

const DEFAULT_POLL_MS = 250;

export class Pipeline {
    private readonly emitter = new EventEmitter();
    private abortController: AbortController | null = null;
    private readonly workers: Promise<void>[] = [];
    private readonly jobAborts = new Map<number, AbortController>();
    private globalConcurrencyOverride: number | null = null;
    private running = false;

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

    enqueue(input: EnqueuePipelineJobInput): PipelineJob {
        const job = this.db.enqueueJob(input);
        logger.info(
            {
                jobId: job.id,
                targetKind: job.targetKind,
                target: job.target,
                stages: job.stages,
                parentJobId: job.parentJobId,
            },
            "youtube pipeline job enqueued"
        );
        this.emit({ type: "job:created", job });

        return job;
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
        this.abortController = new AbortController();
        const requeued = this.db.markInterruptedJobsForRequeue();
        logger.info({ requeued }, "youtube pipeline starting");

        for (const stage of JOB_STAGES) {
            const count = await this.workerCountForStage(stage);
            logger.debug({ stage, count }, "youtube pipeline starting stage workers");

            for (let i = 0; i < count; i++) {
                const workerId = `${this.deps.workerIdPrefix ?? "youtube"}-${stage}-${i}`;
                this.workers.push(this.workerLoop(stage, workerId, this.abortController.signal));
            }
        }
    }

    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }

        logger.info({ workers: this.workers.length }, "youtube pipeline stopping");
        this.running = false;
        this.abortController?.abort();
        await Promise.allSettled(this.workers);
        this.workers.length = 0;
        this.abortController = null;
    }

    private async workerLoop(stage: JobStage, workerId: string, signal: AbortSignal): Promise<void> {
        while (this.running && !signal.aborted) {
            let job: PipelineJob | null = null;

            try {
                job = this.db.claimNextJob(workerId, { stage });
            } catch (error) {
                logger.warn({ err: error, stage, workerId }, "youtube pipeline claim failed (will retry)");
                await sleep(this.deps.pollMs ?? DEFAULT_POLL_MS);
                continue;
            }

            if (!job) {
                await sleep(this.deps.pollMs ?? DEFAULT_POLL_MS);
                continue;
            }

            await this.runJob(job, stage, signal);
        }
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

            await withJobActivity({ jobId: job.id, stage: claimedStage, db: this.db }, () => handler(ctx));
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
            const failed = this.db.getJob(job.id) ?? job;
            logger.error(
                { jobId: failed.id, targetKind: failed.targetKind, target: failed.target, error: message },
                "youtube pipeline job failed"
            );
            this.emit({ type: "job:failed", job: failed, error: message });
        } finally {
            this.jobAborts.delete(job.id);
        }
    }

    private async workerCountForStage(stage: JobStage): Promise<number> {
        if (this.globalConcurrencyOverride !== null) {
            return this.globalConcurrencyOverride;
        }

        const concurrency = await this.config.get("concurrency");

        switch (stage) {
            case "discover":
            case "metadata":
            case "captions":
            case "audio":
                return Math.max(1, concurrency.download);
            case "transcribe":
                return Math.max(1, Math.max(concurrency.localTranscribe, concurrency.cloudTranscribe));
            case "summarize":
                return Math.max(1, concurrency.summarize);
            case "video":
                return Math.max(1, concurrency.download);
        }
    }

    private emit(event: JobEvent): void {
        this.emitter.emit(event.type, event);
    }

    /** Emit pipeline lifecycle events for a job that runs OUTSIDE the queue worker
     *  (e.g. POST /summary which executes synchronously inside the request handler).
     *  Keeps the WS event stream + UI progress bar in sync with synchronous routes. */
    emitExternal(event: JobEvent): void {
        this.emitter.emit(event.type, event);
    }
}

const JOB_STAGES: JobStage[] = ["discover", "metadata", "captions", "audio", "video", "transcribe", "summarize"];

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
