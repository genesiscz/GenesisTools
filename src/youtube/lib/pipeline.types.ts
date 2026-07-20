import type { JobEvent, JobStage, JobStatus, JobTargetKind, PipelineJob } from "@app/youtube/lib/jobs.types";

export interface StageHandlerCtx {
    job: PipelineJob;
    onProgress: (progress: number, message?: string) => void;
    signal: AbortSignal;
}

export type StageHandler = (ctx: StageHandlerCtx) => Promise<void>;

export type PipelineHandlerMap = Record<JobStage, StageHandler>;

export interface PipelineDeps {
    handlers: PipelineHandlerMap;
    pollMs?: number;
    workerIdPrefix?: string;
}

export interface EnqueuePipelineJobInput {
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    parentJobId?: number;
    userId?: number | null;
    params?: Record<string, unknown> | null;
    priority?: number;
    /** Bypass fingerprint reuse and artifact short-circuit. */
    force?: boolean;
}

export interface EnqueuePipelineResult {
    /** Null when `skipped: "artifact"` — no job row was created or reused. */
    job: PipelineJob | null;
    reused: boolean;
    /** 1-based position among pending jobs under priority claim order; null if not pending. */
    queuePosition: number | null;
    /** Set when enqueue was skipped because the artifact already exists. */
    skipped?: "artifact";
}

export interface ListPipelineJobsOpts {
    status?: JobStatus;
    limit?: number;
}

export type JobEventHandler<E extends JobEvent["type"]> = (event: Extract<JobEvent, { type: E }>) => void;
