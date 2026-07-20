import { AsyncLocalStorage } from "node:async_hooks";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { JobActivity, JobActivityKind, JobStage } from "@app/youtube/lib/jobs.types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Per-async-context info that lets AI helpers (callLLM/Embedder/Transcriber)
 * and external fetchers (yt-dlp, youtube-transcript, …) record their work
 * against the pipeline job currently executing on this stack.
 *
 * `Pipeline.runJob` wraps each stage handler in `withJobActivity({...}, () => handler(ctx))`
 * so that any code reachable from the handler can call `getJobActivityContext()` to find
 * out which job/stage it's running under, without threading the value through every signature.
 */
export interface JobActivityContext {
    jobId: number;
    stage: JobStage;
    /** Owner of the running job — attribution for ai_calls. Undefined/null = operator work. */
    userId?: number | null;
    db: YoutubeDatabase;
}

const jobActivityStorage = new AsyncLocalStorage<JobActivityContext>();

const ACTIVITY_TEXT_CAP = 64 * 1024;

export function getJobActivityContext(): JobActivityContext | undefined {
    return jobActivityStorage.getStore();
}

export function withJobActivity<T>(ctx: JobActivityContext, fn: () => Promise<T>): Promise<T> {
    return jobActivityStorage.run(ctx, fn);
}

export interface TraceJobExternalCallOpts<T> {
    action: string;
    /** Tool / library name shown in the activity drawer (e.g. "yt-dlp"). */
    provider?: string;
    /** Optional sub-target (URL, video id, channel handle). */
    model?: string;
    /** Request summary shown under Prompt / Request. */
    prompt?: string | null;
    /** Build a compact response summary for the drawer (never dump full payloads). */
    summarize?: (result: T) => string | null | undefined;
}

/**
 * Time an external API/CLI call and, when a job activity context is active,
 * persist it to `job_activity` as kind `"api"`. No-ops the record when no job
 * is running (CLI paths). Never swallows the underlying error.
 */
export async function traceJobExternalCall<T>(opts: TraceJobExternalCallOpts<T>, fn: () => Promise<T>): Promise<T> {
    const ctx = getJobActivityContext();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    try {
        const result = await fn();

        if (ctx) {
            recordSafe(ctx, {
                kind: "api",
                action: opts.action,
                provider: opts.provider ?? null,
                model: opts.model ?? null,
                prompt: truncateActivityText(opts.prompt ?? null),
                response: truncateActivityText(opts.summarize?.(result) ?? null),
                durationMs: Math.round(performance.now() - t0),
                startedAt,
                completedAt: new Date().toISOString(),
                error: null,
            });
        }

        return result;
    } catch (error) {
        if (ctx) {
            recordSafe(ctx, {
                kind: "api",
                action: opts.action,
                provider: opts.provider ?? null,
                model: opts.model ?? null,
                prompt: truncateActivityText(opts.prompt ?? null),
                response: null,
                durationMs: Math.round(performance.now() - t0),
                startedAt,
                completedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        throw error;
    }
}

export function truncateActivityText(value: string | null | undefined): string | null {
    if (value == null || value === "") {
        return null;
    }

    if (value.length <= ACTIVITY_TEXT_CAP) {
        return value;
    }

    return `${value.slice(0, ACTIVITY_TEXT_CAP)}\n…[truncated]`;
}

export function summarizeJson(value: unknown): string {
    return SafeJSON.stringify(value, { strict: true }) ?? String(value);
}

function recordSafe(
    ctx: JobActivityContext,
    fields: {
        kind: JobActivityKind;
        action: string;
        provider: string | null;
        model: string | null;
        prompt: string | null;
        response: string | null;
        durationMs: number;
        startedAt: string;
        completedAt: string;
        error: string | null;
    }
): void {
    try {
        const row: JobActivity = ctx.db.recordJobActivity({
            jobId: ctx.jobId,
            stage: ctx.stage,
            ...fields,
        });
        logger.debug(
            { jobId: ctx.jobId, stage: ctx.stage, activityId: row.id, action: fields.action, kind: fields.kind },
            "youtube job activity recorded"
        );
    } catch (err) {
        logger.warn(
            { err, action: fields.action, jobId: ctx.jobId },
            "youtube job activity record failed (continuing)"
        );
    }
}
