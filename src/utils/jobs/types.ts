/** One progress report of a job: a recorder's post-processing, an edit, an encode. */
export interface ProgressEvent {
    job: string;
    step: string;
    done: number;
    total: number;
    /** What `done` and `total` count: `frames`, `segments`, `steps`. */
    unit: string;
    message?: string;
    /** ISO time of the event. */
    at: string;
}

export const JOB_STATES = ["running", "done", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobInfo {
    id: string;
    kind: string;
    state: JobState;
    startedAt: string;
    endedAt?: string;
    error?: string;
    /** The latest event of the job. */
    progress?: ProgressEvent;
}

export interface StepReport {
    name: string;
    /** A receipt from an earlier run with the same inputs answered for the step. */
    skipped: boolean;
    ms: number;
}

export interface JobResult<S> {
    state: S;
    steps: StepReport[];
}
