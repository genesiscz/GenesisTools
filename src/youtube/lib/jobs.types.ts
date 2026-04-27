export type JobStage = "discover" | "metadata" | "captions" | "audio" | "transcribe" | "summarize";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type JobTargetKind = "video" | "channel" | "url";

export interface PipelineJob {
    id: number;
    targetKind: JobTargetKind;
    target: string;
    stages: JobStage[];
    currentStage: JobStage | null;
    status: JobStatus;
    error: string | null;
    progress: number;
    progressMessage: string | null;
    parentJobId: number | null;
    workerId: string | null;
    claimedAt: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
}

export type JobEvent =
    | { type: "job:created"; job: PipelineJob }
    | { type: "job:started"; job: PipelineJob }
    | { type: "stage:started"; jobId: number; stage: JobStage }
    | { type: "stage:progress"; jobId: number; stage: JobStage; progress: number; message?: string }
    | { type: "stage:completed"; jobId: number; stage: JobStage }
    | { type: "job:completed"; job: PipelineJob }
    | { type: "job:failed"; job: PipelineJob; error: string }
    | { type: "job:cancelled"; jobId: number };
