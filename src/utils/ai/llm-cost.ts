/**
 * Pure cost math for LLM calls. Pricing DATA does not live here — canonical
 * per-model rates come from the ask model library (`ModelInfo.pricing`,
 * populated by `dynamicPricingManager` from LiteLLM/OpenRouter). The ai-proxy
 * client ledger keeps its own deliberate static table in
 * `src/ai-proxy/lib/billing/pricing.ts` (deterministic invoicing).
 */
export interface TokenPricing {
    inputPer1M: number;
    outputPer1M: number;
}

export interface LlmCallCostOpts {
    pricing: TokenPricing | undefined;
    inputTokens: number;
    outputTokens: number;
}

/** USD for one LLM call. null = no pricing known for the model. */
export function estimateLlmCallCostUsd({ pricing, inputTokens, outputTokens }: LlmCallCostOpts): number | null {
    if (!pricing) {
        return null;
    }

    return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

/** ~150 spoken words/min ≈ 200 tokens/min — token estimate for speech of a given length. */
const SPEECH_TOKENS_PER_SEC = 3.3;

export function estimateSpeechTokens(durationSec: number): number {
    return Math.round(durationSec * SPEECH_TOKENS_PER_SEC);
}
