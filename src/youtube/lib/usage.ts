/**
 * Usage recording for the YouTube tool. All LLM/embedding/transcription calls funnel
 * through here so they show up in `tools usage` (the central UsageDatabase shared
 * with the `ask` tool).
 *
 * Per-call cost is computed by `dynamicPricingManager` (provider+model+token-based).
 * If the provider doesn't return a `LanguageModelUsage`, we still record the action
 * with zeroed tokens so call counts are visible in the dashboard.
 */
import logger from "@app/logger";
import { costTracker } from "@ask/output/CostTracker";
import type { ProviderChoice } from "@ask/types";
import type { LanguageModelUsage } from "ai";

export type YoutubeUsageAction =
    | "summarize:short"
    | "summarize:timestamped"
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
}

/**
 * Best-effort persistence of an AI usage event to the shared usage DB.
 * Never throws — usage telemetry shouldn't break the work it's tracking.
 */
export async function recordYoutubeUsage(input: RecordYoutubeUsageInput): Promise<void> {
    try {
        const sessionId = `youtube:${input.action}${input.scope ? `:${input.scope}` : ""}`;
        const usage: LanguageModelUsage =
            input.usage ?? ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage);
        await costTracker.trackUsage(input.provider, input.model, usage, sessionId);
        logger.debug({ action: input.action, provider: input.provider, model: input.model, scope: input.scope }, "youtube usage recorded");
    } catch (error) {
        logger.warn({ err: error, action: input.action }, "youtube usage record failed (continuing)");
    }
}

/** Pull provider+model identifiers out of a `ProviderChoice` so callers don't have to. */
export function identifyProviderChoice(choice: ProviderChoice): { provider: string; model: string } {
    return { provider: choice.provider.name, model: choice.model.id };
}
