import { describe, expect, it } from "bun:test";
import { billedModelIds, estimateCostUsd, legacyBilledIds } from "@app/ai-proxy/lib/billing/pricing";
import { STATIC_CATALOG } from "@genesiscz/utils/ai/catalog";
import { GROK_STATIC_CATALOG } from "@genesiscz/utils/ai/grok/models";
import { OPENAI_SUB_STATIC_CATALOG } from "@genesiscz/utils/ai/openai/sub-models";

describe("estimateCostUsd", () => {
    it("prices a known model per 1M tokens", () => {
        // grok-4-fast: $0.20/1M in, $0.50/1M out → 1M in + 1M out = $0.70
        expect(estimateCostUsd("grok-4-fast", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })).toBeCloseTo(
            0.7,
            10
        );
    });

    it("folds dated / -latest variant ids onto their base model", () => {
        const cost = estimateCostUsd("claude-haiku-4-5-20251001", {
            prompt_tokens: 2_000_000,
            completion_tokens: 0,
        });
        expect(cost).toBeCloseTo(2.0, 10);
        expect(estimateCostUsd("grok-4.5-latest", { prompt_tokens: 100_000 })).toBeCloseTo(0.2, 10);
    });

    it("never open-ended-prefix-matches: unknown family variants stay unpriced", () => {
        // grok-4.5 must not fall back to grok-4's rate; bare aliases stay unknown.
        expect(estimateCostUsd("grok-4.5.1", { prompt_tokens: 5 })).toBeUndefined();
        expect(estimateCostUsd("sonnet", { prompt_tokens: 5 })).toBeUndefined();
        expect(estimateCostUsd("claude-sonnet-4", { prompt_tokens: 5 })).toBeUndefined();
    });

    it("returns undefined for unknown models and zero-usage requests", () => {
        expect(estimateCostUsd("mystery-model", { prompt_tokens: 5 })).toBeUndefined();
        expect(estimateCostUsd("grok-4-fast", {})).toBe(0);
    });

    it("applies the intro rate before its end date, standard after", () => {
        const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
        // sonnet-5 intro $2/$10 until 2026-09-01, then $3/$15
        expect(estimateCostUsd("claude-sonnet-5", usage, new Date("2026-08-15"))).toBeCloseTo(12, 10);
        expect(estimateCostUsd("claude-sonnet-5", usage, new Date("2026-09-01"))).toBeCloseTo(18, 10);
    });

    it("bills the whole request at long-context rates above the prompt threshold", () => {
        // grok-4.5: $2/$6 flat, $4/$12 once prompt > 200k
        expect(estimateCostUsd("grok-4.5", { prompt_tokens: 200_000, completion_tokens: 0 })).toBeCloseTo(0.4, 10);
        expect(estimateCostUsd("grok-4.5", { prompt_tokens: 300_000, completion_tokens: 100_000 })).toBeCloseTo(
            0.3 * 4 + 0.1 * 12,
            10
        );
    });

    it("prices legacy Opus 4.0 dated ids at the pre-drop rate", () => {
        expect(
            estimateCostUsd("claude-opus-4-20250514", { prompt_tokens: 1_000_000, completion_tokens: 0 })
        ).toBeCloseTo(15, 10);
        expect(estimateCostUsd("claude-opus-4-8", { prompt_tokens: 1_000_000, completion_tokens: 0 })).toBeCloseTo(
            5,
            10
        );
    });
});

describe("billing table coverage", () => {
    // Rates here are deliberately independent of list prices (invoicing source
    // of truth), so this only checks that every priced prefix still names a
    // model somebody can actually call — never that the rates match.
    const grokIds = GROK_STATIC_CATALOG.map((model) => model.id);
    const openAiIds = OPENAI_SUB_STATIC_CATALOG.map((model) => model.slug);
    const catalogIds = [...STATIC_CATALOG.map((model) => model.id), ...grokIds, ...openAiIds, ...legacyBilledIds()];

    /** Sibling proxy tests mock.module the openai catalog process-wide; an empty catalog is a stub, not a gap. */
    function isStubbedProvider(prefix: string): boolean {
        if (prefix.startsWith("gpt")) {
            return openAiIds.length === 0;
        }

        if (prefix.startsWith("grok")) {
            return grokIds.length === 0;
        }

        return false;
    }

    it("prices only exact ids that match a curated or legacy model id", () => {
        const unmatched = billedModelIds().filter(
            (billedId) => !isStubbedProvider(billedId) && !catalogIds.some((id) => id === billedId)
        );

        expect(unmatched).toEqual([]);
    });
});
