/**
 * Static USD-per-1M-token pricing for cost estimation on the client ledger.
 * EXACT id match, with one boundary-safe fallback: a trailing `-YYYYMMDD` /
 * `-latest` suffix is stripped and the exact lookup retried. Never an
 * open-ended prefix match — that once billed grok-4.5 at grok-4's 7.5x higher
 * rate. Unknown model → undefined (ledger records tokens, adds $0, CLI marks
 * the estimate incomplete) — better unpriced than wrongly priced.
 *
 * Rates: public list prices as of 2026-07. Update deliberately; this table is
 * the invoicing source of truth. Cost is booked at WRITE time (see
 * client-ledger), so date-bounded rules resolve against the booking date and a
 * later table edit never rewrites past invoices.
 */
import { stripModelVariantSuffix } from "@genesiscz/utils/ai/models/registry";

interface RatePair {
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
}

/**
 * Conditional rate override. A rule matches when ALL of its bounds hold;
 * the first matching rule wins, else the model's base rates apply.
 * Both providers with context premiums (Anthropic 1M, xAI) bill the ENTIRE
 * request at the higher rate once the prompt crosses the threshold, so a
 * matching context rule reprices the whole request, not just the excess.
 */
interface PriceRule extends RatePair {
    /** Booking date >= from (ISO date, inclusive). */
    from?: string;
    /** Booking date < to (ISO date, exclusive). */
    to?: string;
    /** prompt_tokens > contextFrom. */
    contextFrom?: number;
    /** prompt_tokens <= contextTo. */
    contextTo?: number;
}

interface ModelRate extends RatePair {
    rules?: PriceRule[];
}

const LONG_CONTEXT_THRESHOLD = 200_000;

const OPUS_45_PLUS: ModelRate = { inputUsdPerMTok: 5, outputUsdPerMTok: 25 };
const OPUS_PRE_45: ModelRate = { inputUsdPerMTok: 15, outputUsdPerMTok: 75 };
const SONNET_4_FLAT: ModelRate = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const SONNET_4_LONG_CTX: ModelRate = {
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    rules: [{ contextFrom: LONG_CONTEXT_THRESHOLD, inputUsdPerMTok: 6, outputUsdPerMTok: 22.5 }],
};
const HAIKU_4_5: ModelRate = { inputUsdPerMTok: 1, outputUsdPerMTok: 5 };
const GROK_4: ModelRate = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };
const GROK_4_FAST: ModelRate = { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.5 };
const GROK_CODE_FAST: ModelRate = { inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.5 };
const GROK_4_20: ModelRate = { inputUsdPerMTok: 2, outputUsdPerMTok: 6 };

/**
 * Groups share one rate across every exact id they cover. Dated / `-latest`
 * variants need no entry — stripModelVariantSuffix folds them onto the base id.
 * `claude-opus-4-20250514` (Opus 4.0) IS listed exactly: its stripped base
 * would be the unrelated newer opus-4 line.
 */
const RATE_GROUPS: Array<{ ids: string[]; rate: ModelRate }> = [
    { ids: ["claude-fable-5"], rate: { inputUsdPerMTok: 25, outputUsdPerMTok: 125 } },
    {
        ids: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
        rate: OPUS_45_PLUS,
    },
    { ids: ["claude-opus-4-1", "claude-opus-4-20250514"], rate: OPUS_PRE_45 },
    {
        ids: ["claude-sonnet-5"],
        rate: {
            inputUsdPerMTok: 3,
            outputUsdPerMTok: 15,
            // Introductory launch pricing.
            rules: [{ to: "2026-09-01", inputUsdPerMTok: 2, outputUsdPerMTok: 10 }],
        },
    },
    { ids: ["claude-sonnet-4-6"], rate: SONNET_4_FLAT },
    { ids: ["claude-sonnet-4-5"], rate: SONNET_4_LONG_CTX },
    { ids: ["claude-haiku-4-5"], rate: HAIKU_4_5 },
    { ids: ["gpt-5.6-sol"], rate: { inputUsdPerMTok: 5, outputUsdPerMTok: 30 } },
    { ids: ["gpt-5.6-terra"], rate: { inputUsdPerMTok: 2.5, outputUsdPerMTok: 15 } },
    { ids: ["gpt-5.6-luna"], rate: { inputUsdPerMTok: 1, outputUsdPerMTok: 6 } },
    { ids: ["gpt-5.5"], rate: { inputUsdPerMTok: 5, outputUsdPerMTok: 30 } },
    { ids: ["gpt-5-codex"], rate: { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 } },
    {
        ids: ["grok-4.5"],
        rate: {
            inputUsdPerMTok: 2,
            outputUsdPerMTok: 6,
            rules: [{ contextFrom: LONG_CONTEXT_THRESHOLD, inputUsdPerMTok: 4, outputUsdPerMTok: 12 }],
        },
    },
    {
        ids: ["grok-4.3"],
        rate: {
            inputUsdPerMTok: 1.25,
            outputUsdPerMTok: 2.5,
            rules: [{ contextFrom: LONG_CONTEXT_THRESHOLD, inputUsdPerMTok: 2.5, outputUsdPerMTok: 5 }],
        },
    },
    { ids: ["grok-4.20", "grok-4.20-multi-agent", "grok-4.20-0309-reasoning"], rate: GROK_4_20 },
    { ids: ["grok-4", "grok-4-0709"], rate: GROK_4 },
    {
        ids: [
            "grok-4-fast",
            "grok-4-fast-reasoning",
            "grok-4-fast-non-reasoning",
            "grok-4-1-fast",
            "grok-4-1-fast-reasoning",
            "grok-4-1-fast-non-reasoning",
            "grok-4.1-fast",
            "grok-4.1-fast-reasoning",
        ],
        rate: GROK_4_FAST,
    },
    { ids: ["grok-code-fast", "grok-code-fast-1"], rate: GROK_CODE_FAST },
];

const MODEL_RATES: ReadonlyMap<string, ModelRate> = new Map(
    RATE_GROUPS.flatMap((group) => group.ids.map((id): [string, ModelRate] => [id, group.rate]))
);

/** Exact model ids this table prices — coverage checks read this, not the rates. */
export function billedModelIds(): string[] {
    return [...MODEL_RATES.keys()];
}

/**
 * Billed ids absent from today's curated catalogs: retired models, undated cli
 * forms, or dot-variant upstream ids still seen in usage.
 */
export function legacyBilledIds(): string[] {
    return [
        "claude-opus-4-20250514",
        "claude-opus-4-1",
        "claude-opus-4-5",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
        "grok-4.1-fast",
        "grok-4.1-fast-reasoning",
        "grok-4.20-0309-reasoning",
    ];
}

function findRate(upstreamModel: string): ModelRate | undefined {
    const exact = MODEL_RATES.get(upstreamModel);

    if (exact) {
        return exact;
    }

    const base = stripModelVariantSuffix(upstreamModel);
    return base ? MODEL_RATES.get(base) : undefined;
}

export function estimateCostUsd(
    upstreamModel: string,
    usage: { prompt_tokens?: number; completion_tokens?: number },
    at: Date = new Date()
): number | undefined {
    const rate = findRate(upstreamModel);

    if (!rate) {
        return undefined;
    }

    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const pair = resolvePair(rate, input, at);
    return (input / 1_000_000) * pair.inputUsdPerMTok + (output / 1_000_000) * pair.outputUsdPerMTok;
}

function resolvePair(rate: ModelRate, promptTokens: number, at: Date): RatePair {
    const day = at.toISOString().slice(0, 10);

    for (const rule of rate.rules ?? []) {
        if (rule.from && day < rule.from) {
            continue;
        }

        if (rule.to && day >= rule.to) {
            continue;
        }

        if (rule.contextFrom != null && promptTokens <= rule.contextFrom) {
            continue;
        }

        if (rule.contextTo != null && promptTokens > rule.contextTo) {
            continue;
        }

        return rule;
    }

    return rate;
}
