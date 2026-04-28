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
}

export interface ListPipelineJobsOpts {
    status?: JobStatus;
    limit?: number;
}

export type JobEventHandler<E extends JobEvent["type"]> = (event: Extract<JobEvent, { type: E }>) => void;
