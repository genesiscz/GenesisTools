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
import logger from "@app/logger";
import { getJobActivityContext } from "@app/youtube/lib/job-activity";
import type { JobActivityKind } from "@app/youtube/lib/jobs.types";
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
    | "transcribe:ai";

export interface RecordYoutubeUsageInput {
    action: YoutubeUsageAction;
    provider: string;
    model: string;
    usage?: LanguageModelUsage;
    /** Free-form scope: video id or "channel:@handle" so the operator can group. */
    scope?: string;
    /** When set, surfaces in the jobs-inspector activity drawer. Truncated to 64 KB. */
    prompt?: string | null;
    response?: string | null;
    durationMs?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
}

/**
 * Best-effort persistence of an AI usage event to the shared usage DB and (if a job
 * activity context is active) the youtube `job_activity` table. Never throws —
 * usage telemetry shouldn't break the work it's tracking.
 */
export async function recordYoutubeUsage(input: RecordYoutubeUsageInput): Promise<void> {
    try {
        const sessionId = `youtube:${input.action}${input.scope ? `:${input.scope}` : ""}`;
        const usage: LanguageModelUsage =
            input.usage ?? ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage);
        await costTracker.trackUsage(input.provider, input.model, usage, sessionId);
        logger.debug(
            { action: input.action, provider: input.provider, model: input.model, scope: input.scope },
            "youtube usage recorded"
        );

        const ctx = getJobActivityContext();

        if (ctx) {
            const costUsd = await safeCalculateCost(input.provider, input.model, usage);
            ctx.db.recordJobActivity({
                jobId: ctx.jobId,
                stage: ctx.stage,
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
        logger.warn({ err: error, action: input.action }, "youtube usage record failed (continuing)");
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
