import { EventEmitter } from "node:events";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { JobEvent, JobStage, PipelineJob } from "@app/youtube/lib/jobs.types";
import type { EnqueuePipelineJobInput, JobEventHandler, ListPipelineJobsOpts, PipelineDeps, StageHandlerCtx } from "@app/youtube/lib/pipeline.types";

const DEFAULT_POLL_MS = 250;

export class Pipeline {
    private readonly emitter = new EventEmitter();
    private abortController: AbortController | null = null;
    private readonly workers: Promise<void>[] = [];
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
        this.db.markInterruptedJobsForRequeue();

        for (const stage of JOB_STAGES) {
            const count = await this.workerCountForStage(stage);

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

        this.running = false;
        this.abortController?.abort();
        await Promise.allSettled(this.workers);
        this.workers.length = 0;
        this.abortController = null;
    }

    private async workerLoop(stage: JobStage, workerId: string, signal: AbortSignal): Promise<void> {
        while (this.running && !signal.aborted) {
            const job = this.db.claimNextJob(workerId, { stage });

            if (!job) {
                await sleep(this.deps.pollMs ?? DEFAULT_POLL_MS);
                continue;
            }

            await this.runJob(job, signal);
        }
    }

    private async runJob(job: PipelineJob, signal: AbortSignal): Promise<void> {
        this.emit({ type: "job:started", job });

        try {
            for (const [index, stage] of job.stages.entries()) {
                if (!this.running || signal.aborted) {
                    return;
                }

                const handler = this.deps.handlers[stage];

                if (!handler) {
                    throw new Error(`No handler registered for stage ${stage}`);
                }

                this.db.updateJob(job.id, { currentStage: stage, progress: index / job.stages.length, progressMessage: null });
                this.emit({ type: "stage:started", jobId: job.id, stage });

                const ctx: StageHandlerCtx = {
                    job: this.db.getJob(job.id) ?? job,
                    signal,
                    onProgress: (progress, message) => {
                        this.db.updateJob(job.id, { progress, progressMessage: message ?? null });
                        this.emit({ type: "stage:progress", jobId: job.id, stage, progress, message });
                    },
                };

                await handler(ctx);
                this.emit({ type: "stage:completed", jobId: job.id, stage });
            }

            this.db.updateJob(job.id, { status: "completed", completedAt: new Date().toISOString(), progress: 1, progressMessage: null, currentStage: null });
            const completed = this.db.getJob(job.id) ?? job;
            this.emit({ type: "job:completed", job: completed });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.db.updateJob(job.id, { status: "failed", error: message, completedAt: new Date().toISOString() });
            const failed = this.db.getJob(job.id) ?? job;
            this.emit({ type: "job:failed", job: failed, error: message });
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
}

const JOB_STAGES: JobStage[] = ["discover", "metadata", "captions", "audio", "video", "transcribe", "summarize"];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
