/**
 * Static USD-per-1M-token pricing for cost estimation on the client ledger.
 * Longest-prefix match so dated ids (claude-haiku-4-5-20251001) hit their
 * family entry. Unknown model → undefined (ledger records tokens, adds $0,
 * CLI marks the estimate incomplete) — never guess a price.
 *
 * Rates: public list prices as of 2026-07. Update deliberately; this table is
 * the invoicing source of truth.
 */
interface ModelRate {
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
}

const MODEL_RATES: Record<string, ModelRate> = {
    "claude-fable-5": { inputUsdPerMTok: 25, outputUsdPerMTok: 125 },
    "claude-opus-4": { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
    "claude-sonnet-4": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    "claude-haiku-4": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
    "gpt-5.5": { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
    "gpt-5-codex": { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
    "grok-4-fast": { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.5 },
    "grok-4": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    "grok-code-fast": { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.5 },
};

function findRate(upstreamModel: string): ModelRate | undefined {
    let best: { prefix: string; rate: ModelRate } | undefined;

    for (const [prefix, rate] of Object.entries(MODEL_RATES)) {
        if (upstreamModel.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
            best = { prefix, rate };
        }
    }

    return best?.rate;
}

export function estimateCostUsd(
    upstreamModel: string,
    usage: { prompt_tokens?: number; completion_tokens?: number }
): number | undefined {
    const rate = findRate(upstreamModel);

    if (!rate) {
        return undefined;
    }

    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    return (input / 1_000_000) * rate.inputUsdPerMTok + (output / 1_000_000) * rate.outputUsdPerMTok;
}
