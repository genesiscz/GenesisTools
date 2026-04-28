export type JobStage = "discover" | "metadata" | "captions" | "audio" | "video" | "transcribe" | "summarize";

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
    | { type: "job:cancelled"; jobId: number }
    | { type: "job:activity"; jobId: number; activityId: number };

export type JobActivityKind = "llm" | "embed" | "transcribe";

/**
 * One AI/API event recorded against a pipeline job (LLM call, embedding batch, transcription).
 * Surfaces in the jobs inspector drawer so the operator can see prompt/response/cost per call.
 */
export interface JobActivity {
    id: number;
    jobId: number;
    stage: JobStage | null;
    kind: JobActivityKind;
    action: string | null;
    provider: string | null;
    model: string | null;
    prompt: string | null;
    response: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    tokensTotal: number | null;
    costUsd: number | null;
    durationMs: number | null;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    createdAt: string;
}
