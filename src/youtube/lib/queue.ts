import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { ListJobsOpts, QueueStats } from "@app/youtube/lib/db.types";
import {
    JOB_STAGES,
    JOB_STATUSES,
    JOB_TARGET_KINDS,
    type JobActivity,
    type JobStage,
    type JobStatus,
    type JobTargetKind,
    type PipelineJob,
} from "@app/youtube/lib/jobs.types";
import type { Pipeline } from "@app/youtube/lib/pipeline";
import type { EnqueuePipelineResult } from "@app/youtube/lib/pipeline.types";
import { getRequestContext } from "@app/youtube/lib/request-context";
import type { VideoId } from "@app/youtube/lib/video.types";
import { logger } from "@genesiscz/utils/logger";

const SERVER_OWNED_PARAM_KEYS = ["holdId", "creditCost"] as const;
// Redaction covers the read surface, not storage. `question` / `presetInstructions`
// ARE the job's input — the `qa` stage reads them back out of `params_json` and
// throws without them (`Youtube.stages.qa`) — so they have to be persisted. What
// this prevents is one user's question travelling back out of the multi-user HTTP
// API on someone else's job listing; the file itself is per-install under
// `~/.genesis-tools/youtube/`.
const SENSITIVE_PARAM_KEYS = ["holdId", "creditCost", "question", "presetInstructions"] as const;
const WATCH_LIST_LIMIT = 100_000;
const FINAL_JOB_STATUSES = new Set<JobStatus>(["completed", "failed", "cancelled"]);

export const CHANNEL_URL_PATTERN = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(@[A-Za-z0-9_.-]+)/;

/**
 * Whose jobs an operation may touch.
 *
 * A discriminated union rather than an optional `userId`, because an omitted owner
 * still has to mean something and "unscoped" is the dangerous default: the reads
 * below run behind a gate that accepts ANY valid `ytu_` user token
 * (`requireServiceKey`, server/auth.ts), so a caller that forgot the field would
 * hand one user the whole queue. Naming the operator case makes each door state
 * its reach in writing.
 */
export type JobActor = { kind: "operator" } | { kind: "user"; userId: number };

export interface QueueEnqueueInput {
    target: string;
    targetKind?: JobTargetKind;
    stages: JobStage[];
    userId?: number | null;
    params?: Record<string, unknown> | null;
    priority?: number;
    force?: boolean;
    parentJobId?: number;
}

export interface WatchQueueOpts {
    jobIds?: number[];
    followChildren?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
    includeActivity?: boolean;
    signal?: AbortSignal;
}

export type QueueWatchEvent =
    | { type: "job:seen"; at: string; job: PipelineJob }
    | { type: "job:status"; at: string; jobId: number; from: JobStatus; to: JobStatus; job: PipelineJob }
    | {
          type: "job:stage";
          at: string;
          jobId: number;
          from: JobStage | null;
          to: JobStage | null;
          job: PipelineJob;
      }
    | {
          type: "job:progress";
          at: string;
          jobId: number;
          stage: JobStage | null;
          progress: number;
          message: string | null;
      }
    | { type: "job:activity"; at: string; jobId: number; activity: JobActivity }
    | { type: "watch:done"; at: string; jobIds: number[]; reason: "complete" | "timeout" | "aborted" };

export class QueueService {
    constructor(
        private readonly pipeline: Pipeline,
        private readonly db: YoutubeDatabase
    ) {}

    enqueue(input: QueueEnqueueInput): EnqueuePipelineResult {
        const target = normaliseTarget(input.target);
        const targetKind = input.targetKind ?? resolveTargetKind(target);

        if (!isStringMember(JOB_TARGET_KINDS, targetKind)) {
            throw new Error(`Unknown job target kind: ${targetKind}`);
        }

        const stages = toJobStages(input.stages);
        const params = sanitizeParams(input.params ?? null);
        // Fall back to the ambient owner instead of persisting an unowned job. HTTP
        // routes pass `userId` explicitly; CLI/MCP callers run inside
        // `withConsoleContext`, which puts the console service user in this ALS.
        // Fixed here rather than at each call site so a new caller cannot forget it.
        const userId = input.userId ?? getRequestContext()?.userId ?? null;

        if (userId === null) {
            // Not fatal: `pipeline.enqueue` accepts a null owner and anonymous HTTP
            // paths use it deliberately. It IS worth a line in the log, because the
            // other way to get here is a new CLI/MCP caller that forgot
            // `withConsoleContext`, and the symptom (no ai_calls rows, job invisible
            // to its owner) is otherwise silent.
            logger.warn({ target, targetKind, stages }, "youtube queue: enqueuing an unowned job (no userId in scope)");
        }

        return this.pipeline.enqueue({
            target,
            targetKind,
            stages,
            userId,
            params,
            priority: input.priority,
            force: input.force,
            parentJobId: input.parentJobId,
        });
    }

    list(opts: ListJobsOpts & { redact?: boolean; actor: JobActor }): PipelineJob[] {
        const { redact = false, actor, ...listOpts } = opts;
        // `userId` last, so a caller-supplied filter can narrow an operator's view
        // but can never widen a user's beyond their own rows.
        const jobs = this.db.listJobs(actor.kind === "user" ? { ...listOpts, userId: actor.userId } : listOpts);

        return redact ? jobs.map(redactJobForApi) : jobs;
    }

    get(
        id: number,
        opts: { redact?: boolean; actor: JobActor }
    ): { job: PipelineJob; queuePosition: number | null } | null {
        const job = this.db.getJob(id);

        if (!job || !actorOwnsJob(job, opts.actor)) {
            return null;
        }

        return {
            job: opts.redact ? redactJobForApi(job) : job,
            queuePosition: this.db.getJobQueuePosition(id),
        };
    }

    activity(id: number, actor: JobActor): JobActivity[] | null {
        const job = this.db.getJob(id);

        if (!job || !actorOwnsJob(job, actor)) {
            return null;
        }

        return this.db.listJobActivity(id);
    }

    cancel(id: number, actor: JobActor): PipelineJob | null {
        const job = this.db.getJob(id);

        if (!job || !actorOwnsJob(job, actor)) {
            return null;
        }

        this.pipeline.cancelJob(id);

        return this.db.getJob(id);
    }

    stats(): QueueStats {
        return this.db.getQueueStats();
    }

    async *watch(opts: WatchQueueOpts): AsyncGenerator<QueueWatchEvent> {
        const startedAt = Date.now();
        const intervalMs = opts.intervalMs ?? 500;
        const includeActivity = opts.includeActivity ?? true;
        const previous = new Map<number, PipelineJob>();
        const activityHighWater = new Map<number, number>();
        // Rows already on disk when the watch opened are history, not events.
        let activityFloor = includeActivity ? this.db.maxJobActivityId() : 0;
        const seenJobIds = new Set<number>();
        const evictedJobIds = new Set<number>();

        while (true) {
            if (opts.signal?.aborted) {
                yield watchDone({ seenJobIds, reason: "aborted" });
                return;
            }

            if (opts.timeoutMs !== undefined && Date.now() - startedAt >= opts.timeoutMs) {
                yield watchDone({ seenJobIds, reason: "timeout" });
                return;
            }

            let jobs = this.jobsInScope(opts);
            const finalPassJobIds = new Set<number>();

            if (opts.jobIds === undefined) {
                jobs = jobs.filter((job) => !evictedJobIds.has(job.id));
                const activeJobIds = new Set(jobs.map((job) => job.id));

                for (const jobId of previous.keys()) {
                    if (activeJobIds.has(jobId) || evictedJobIds.has(jobId)) {
                        continue;
                    }

                    const departedJob = this.db.getJob(jobId);

                    if (!departedJob) {
                        evictedJobIds.add(jobId);
                        continue;
                    }

                    jobs.push(departedJob);
                    finalPassJobIds.add(jobId);
                }

                jobs.sort((left, right) => left.id - right.id);
            }

            const currentIds = new Set(jobs.map((job) => job.id));

            for (const jobId of previous.keys()) {
                if (!currentIds.has(jobId)) {
                    previous.delete(jobId);
                    activityHighWater.delete(jobId);
                }
            }

            for (const job of jobs) {
                const prior = previous.get(job.id);
                previous.set(job.id, job);
                seenJobIds.add(job.id);

                if (!prior) {
                    activityHighWater.set(job.id, highestActivityId(this.db.listJobActivity(job.id)));
                    yield { type: "job:seen", at: nowIso(), job };
                    continue;
                }

                if (prior.status !== job.status) {
                    yield {
                        type: "job:status",
                        at: nowIso(),
                        jobId: job.id,
                        from: prior.status,
                        to: job.status,
                        job,
                    };
                }

                if (prior.currentStage !== job.currentStage) {
                    yield {
                        type: "job:stage",
                        at: nowIso(),
                        jobId: job.id,
                        from: prior.currentStage,
                        to: job.currentStage,
                        job,
                    };
                }

                if (prior.progress !== job.progress || prior.progressMessage !== job.progressMessage) {
                    yield {
                        type: "job:progress",
                        at: nowIso(),
                        jobId: job.id,
                        stage: job.currentStage,
                        progress: job.progress,
                        message: job.progressMessage,
                    };
                }
            }

            if (includeActivity) {
                // ONE query per tick, not one per watched job: an all-jobs watch can
                // hold up to WATCH_LIST_LIMIT jobs, so the per-job form issued tens of
                // thousands of statements every 500ms. `activityFloor` is the global
                // high-water mark; the per-job map still decides what a newly seen job
                // is allowed to replay.
                const watchedJobIds = new Set(jobs.map((job) => job.id));

                for (const activity of this.db.listJobActivityAfter(activityFloor)) {
                    activityFloor = Math.max(activityFloor, activity.id);

                    if (!watchedJobIds.has(activity.jobId)) {
                        continue;
                    }

                    if (activity.id <= (activityHighWater.get(activity.jobId) ?? 0)) {
                        continue;
                    }

                    activityHighWater.set(activity.jobId, activity.id);
                    yield { type: "job:activity", at: nowIso(), jobId: activity.jobId, activity };
                }
            }

            for (const jobId of finalPassJobIds) {
                evictedJobIds.add(jobId);
            }

            if (opts.jobIds !== undefined && allWatchedJobsFinal(opts.jobIds, jobs)) {
                yield watchDone({ seenJobIds, reason: "complete" });
                return;
            }

            await waitForPoll({ intervalMs, signal: opts.signal });
        }
    }

    async waitForJob(jobId: number, opts?: { timeoutMs?: number }): Promise<PipelineJob> {
        const immediate = this.db.getJob(jobId);

        if (immediate && isFinalJobStatus(immediate.status)) {
            return immediate;
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setInterval> | null = null;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const disposers: Array<() => void> = [];
            const cleanup = () => {
                if (timer) {
                    clearInterval(timer);
                }

                if (timeout) {
                    clearTimeout(timeout);
                }

                for (const dispose of disposers) {
                    dispose();
                }
            };
            const resolveOnce = (job: PipelineJob) => {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                resolve(job);
            };
            const rejectOnce = (error: Error) => {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                reject(error);
            };

            disposers.push(
                this.pipeline.on("job:completed", (event) => {
                    if (event.job.id === jobId) {
                        resolveOnce(event.job);
                    }
                }),
                // Resolve rather than reject: the 100ms poll below already resolves
                // ANY final status, so whichever won the race decided whether the
                // caller got a row or a throw. Every terminal status now resolves —
                // callers render `status` + `error` (and `Promise.all` over a batch no
                // longer loses the other jobs' rows because one of them failed).
                this.pipeline.on("job:failed", (event) => {
                    if (event.job.id === jobId) {
                        resolveOnce(event.job);
                    }
                })
            );
            timer = setInterval(() => {
                const job = this.db.getJob(jobId);

                if (!job) {
                    // "No row" is terminal, not "not yet". Callers pass an id they just
                    // enqueued, so reaching here means the row was deleted underneath
                    // us (cache clear, retention GC) or the id was never real — and
                    // most callers pass no timeout, so treating it as pending parked
                    // the CLI forever with nothing on screen.
                    rejectOnce(new Error(`Job ${jobId} no longer exists`));

                    return;
                }

                if (isFinalJobStatus(job.status)) {
                    resolveOnce(job);
                }
            }, 100);

            if (opts?.timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    rejectOnce(new Error(`Timed out waiting for job ${jobId} after ${opts.timeoutMs}ms`));
                }, opts.timeoutMs);
            }
        });
    }

    private jobsInScope(opts: WatchQueueOpts): PipelineJob[] {
        if (opts.jobIds === undefined) {
            return [
                ...this.db.listJobs({ status: "pending", limit: WATCH_LIST_LIMIT }),
                ...this.db.listJobs({
                    status: "running",
                    limit: WATCH_LIST_LIMIT,
                }),
            ].sort((left, right) => left.id - right.id);
        }

        const jobsById = new Map<number, PipelineJob>();

        for (const jobId of opts.jobIds) {
            const job = this.db.getJob(jobId);

            if (job) {
                jobsById.set(job.id, job);
            }

            if (opts.followChildren ?? true) {
                const children = this.db.listJobs({ parentJobId: jobId, limit: WATCH_LIST_LIMIT });

                for (const child of children) {
                    jobsById.set(child.id, child);
                }
            }
        }

        return [...jobsById.values()].sort((left, right) => left.id - right.id);
    }
}

export function extractVideoId(value: string): VideoId | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) {
            return match[1] as VideoId;
        }
    }

    return null;
}

export function resolveTargetKind(target: string): JobTargetKind {
    if (target.startsWith("@") || CHANNEL_URL_PATTERN.test(target)) {
        return "channel";
    }

    if (extractVideoId(target)) {
        return "video";
    }

    if (target.includes("://")) {
        return "url";
    }

    return "video";
}

/**
 * Canonical `@handle` form. Accepts a channel URL, an already-prefixed handle, or
 * a bare name — a bare `mkbhd` would otherwise never match the `@mkbhd` rows the
 * database actually stores.
 */
export function normaliseHandle(input: string): ChannelHandle {
    const trimmed = input.trim();
    const match = CHANNEL_URL_PATTERN.exec(trimmed);

    if (match) {
        return match[1] as ChannelHandle;
    }

    return (trimmed.startsWith("@") ? trimmed : `@${trimmed}`) as ChannelHandle;
}

export function normaliseTarget(target: string): string {
    const trimmed = target.trim();
    const channel = CHANNEL_URL_PATTERN.exec(trimmed);

    if (channel) {
        return channel[1];
    }

    const videoId = extractVideoId(trimmed);

    if (videoId) {
        return videoId;
    }

    return trimmed;
}

export function toJobStages(values: string[]): JobStage[] {
    return values.map((value) => {
        if (!isStringMember(JOB_STAGES, value)) {
            throw new Error(`Unknown pipeline stage: ${value}`);
        }

        return value;
    });
}

/**
 * A job the actor may not touch is reported as absent, never as forbidden.
 *
 * 403 on someone else's id and 404 on an unused one would turn the endpoints into
 * an existence oracle over the whole jobs table. An unowned job (`userId === null`,
 * enqueued by the CLI service user or an anonymous path) belongs to the operator
 * alone, which the strict equality below already gives us.
 */
function actorOwnsJob(job: PipelineJob, actor: JobActor): boolean {
    return actor.kind === "operator" || job.userId === actor.userId;
}

/**
 * Non-throwing counterpart to `toJobStages`, for request parsing.
 *
 * `toJobStages` throws, which is right for a programming error inside the pipeline
 * but wrong at an HTTP door: the throw travelled to the outer catch and came back
 * as a 500 for what is a plain bad request.
 */
export function parseJobStages(value: unknown): JobStage[] | null {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }

    const stages: JobStage[] = [];

    for (const entry of value) {
        if (typeof entry !== "string" || !isStringMember(JOB_STAGES, entry)) {
            return null;
        }

        stages.push(entry);
    }

    return stages;
}

export function parseJobStatus(value: string | null): JobStatus | null {
    if (value !== null && isStringMember(JOB_STATUSES, value)) {
        return value;
    }

    return null;
}

export function sanitizeParams(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) {
        return null;
    }

    const clean = { ...params };

    for (const key of SERVER_OWNED_PARAM_KEYS) {
        delete clean[key];
    }

    return clean;
}

export function redactJobForApi(job: PipelineJob): PipelineJob {
    if (!job.params) {
        return job;
    }

    const params = { ...job.params };

    for (const key of SENSITIVE_PARAM_KEYS) {
        delete params[key];
    }

    return { ...job, params };
}

function isStringMember<T extends string>(values: readonly T[], value: string): value is T {
    return values.some((candidate) => candidate === value);
}

function isFinalJobStatus(status: JobStatus): boolean {
    return FINAL_JOB_STATUSES.has(status);
}

function highestActivityId(activities: JobActivity[]): number {
    return activities.reduce((highest, activity) => Math.max(highest, activity.id), 0);
}

function allWatchedJobsFinal(jobIds: number[], jobs: PipelineJob[]): boolean {
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const rootsFinal = jobIds.every((jobId) => {
        const job = jobsById.get(jobId);

        // A watched id with no row is terminal, not pending: `jobsInScope` only
        // returns rows that exist, so treating "absent" as unfinished meant a
        // deleted or mistyped id polled until the caller's timeout or abort.
        return job ? isFinalJobStatus(job.status) : true;
    });

    return rootsFinal && jobs.every((job) => isFinalJobStatus(job.status));
}

function watchDone({
    seenJobIds,
    reason,
}: {
    seenJobIds: Set<number>;
    reason: "complete" | "timeout" | "aborted";
}): QueueWatchEvent {
    return {
        type: "watch:done",
        at: nowIso(),
        jobIds: [...seenJobIds].sort((left, right) => left - right),
        reason,
    };
}

function nowIso(): string {
    return new Date().toISOString();
}

function waitForPoll({ intervalMs, signal }: { intervalMs: number; signal?: AbortSignal }): Promise<void> {
    if (signal?.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, intervalMs);
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
