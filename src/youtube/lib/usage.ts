/**
 * Usage recording for the YouTube tool. All LLM/embedding/transcription calls funnel
 * through here so they show up in `tools usage` (the central UsageDatabase shared
 * with the `ask` tool).
 *
 * Per-call cost is computed by `dynamicPricingManager` (provider+model+token-based).
 * If the provider doesn't return a `LanguageModelUsage`, we still record the action
 * with zeroed tokens so call counts are visible in the dashboard.
 *
 * When called inside `withJobActivity(...)` (Pipeline stage handlers), the usage is
 * also written to `job_activity` so the jobs inspector can show prompts/responses/cost
 * per pipeline job.
 */
import { logger } from "@app/logger";
import { getJobActivityContext } from "@app/youtube/lib/job-activity";
import type { JobActivityKind } from "@app/youtube/lib/jobs.types";
import { getRequestContext } from "@app/youtube/lib/request-context";
import { costTracker } from "@ask/output/CostTracker";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import type { ProviderChoice } from "@ask/types";
import type { LanguageModelUsage } from "ai";

export type YoutubeUsageAction =
    | "summarize:short"
    | "summarize:timestamped"
    | "summarize:long"
    | "qa:ask"
    | "qa:embed"
    | "transcribe:ai"
    | "transcript:translate"
    | "report:synthesize"
    | "tts:summary";

export interface RecordYoutubeUsageInput {
    action: YoutubeUsageAction;
    provider: string;
    model: string;
    usage?: LanguageModelUsage;
    /** Free-form scope: video id or "channel:@handle" so the operator can group. */
    scope?: string;
    /** Video the call was about — lands in `ai_calls.video_id` for the audit trail. */
    videoId?: string | null;
    /** When set, surfaces in the jobs-inspector activity drawer. Truncated to 64 KB. */
    prompt?: string | null;
    response?: string | null;
    durationMs?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
}

/**
 * Best-effort persistence of an AI usage event to (1) the shared usage DB,
 * (2) the youtube `job_activity` table when a job context is active, and
 * (3) the youtube `ai_calls` audit table when either a job or request context
 * provides a DB handle. Never throws, and each sink fails independently —
 * usage telemetry shouldn't break the work it's tracking.
 */
export async function recordYoutubeUsage(input: RecordYoutubeUsageInput): Promise<void> {
    const usage: LanguageModelUsage =
        input.usage ?? ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage);
    const jobCtx = getJobActivityContext();
    const requestCtx = getRequestContext();
    const costUsd = await safeCalculateCost(input.provider, input.model, usage);

    try {
        const sessionId = `youtube:${input.action}${input.scope ? `:${input.scope}` : ""}`;
        await costTracker.trackUsage(input.provider, input.model, usage, sessionId);
        logger.debug(
            { action: input.action, provider: input.provider, model: input.model, scope: input.scope },
            "youtube usage recorded"
        );
    } catch (error) {
        logger.warn({ err: error, action: input.action }, "youtube usage tracker failed (continuing)");
    }

    try {
        if (jobCtx) {
            jobCtx.db.recordJobActivity({
                jobId: jobCtx.jobId,
                stage: jobCtx.stage,
                kind: actionToKind(input.action),
                action: input.action,
                provider: input.provider,
                model: input.model,
                prompt: input.prompt ?? null,
                response: input.response ?? null,
                tokensIn: usage.inputTokens ?? null,
                tokensOut: usage.outputTokens ?? null,
                tokensTotal: usage.totalTokens ?? null,
                costUsd,
                durationMs: input.durationMs ?? null,
                startedAt: input.startedAt ?? null,
                completedAt: input.completedAt ?? null,
                error: input.error ?? null,
            });
        }
    } catch (error) {
        logger.warn({ err: error, action: input.action }, "youtube job activity record failed (continuing)");
    }

    try {
        const db = jobCtx?.db ?? requestCtx?.db;

        if (db) {
            db.recordAiCall({
                provider: input.provider,
                model: input.model,
                action: input.action,
                videoId: input.videoId ?? null,
                userId: jobCtx?.userId ?? requestCtx?.userId ?? null,
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                costUsd,
                creditsCharged: null,
                jobId: jobCtx?.jobId ?? null,
            });
        } else {
            logger.debug({ action: input.action }, "youtube ai_calls skipped: no db in context (CLI path)");
        }
    } catch (error) {
        logger.warn({ err: error, action: input.action }, "youtube ai_calls record failed (continuing)");
    }
}

/** Pull provider+model identifiers out of a `ProviderChoice` so callers don't have to. */
export function identifyProviderChoice(choice: ProviderChoice): { provider: string; model: string } {
    return { provider: choice.provider.name, model: choice.model.id };
}

function actionToKind(action: YoutubeUsageAction): JobActivityKind {
    if (action === "qa:embed") {
        return "embed";
    }

    if (action === "transcribe:ai") {
        return "transcribe";
    }

    return "llm";
}

async function safeCalculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number | null> {
    try {
        const cost = await dynamicPricingManager.calculateCost(provider, model, usage);
        return Number.isFinite(cost) ? cost : null;
    } catch {
        return null;
    }
}
