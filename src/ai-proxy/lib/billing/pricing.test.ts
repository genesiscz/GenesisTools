import { describe, expect, it } from "bun:test";
import { estimateCostUsd } from "@app/ai-proxy/lib/billing/pricing";

describe("estimateCostUsd", () => {
    it("prices a known model per 1M tokens", () => {
        // grok-4-fast: $0.20/1M in, $0.50/1M out → 1M in + 1M out = $0.70
        expect(estimateCostUsd("grok-4-fast", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })).toBeCloseTo(
            0.7,
            10
        );
    });

    it("matches dated model ids by prefix", () => {
        const cost = estimateCostUsd("claude-haiku-4-5-20251001", {
            prompt_tokens: 2_000_000,
            completion_tokens: 0,
        });
        expect(cost).toBeCloseTo(2.0, 10);
    });

    it("returns undefined for unknown models and zero-usage requests", () => {
        expect(estimateCostUsd("mystery-model", { prompt_tokens: 5 })).toBeUndefined();
        expect(estimateCostUsd("grok-4-fast", {})).toBe(0);
    });
});
