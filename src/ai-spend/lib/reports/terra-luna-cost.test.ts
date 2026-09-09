import { expect, test } from "bun:test";
import { codexDriver } from "../drivers/codex";
import { DEFAULT_PRICING } from "../pricing";
import { catalogEstimate } from "./cost";
import type { SpendEvent } from "./types";

// Regression: quota investigation found Terra/Luna were priced as generic GPT-5.6.
test("Terra and Luna use exact API rates at the context boundary and priority tier", () => {
    const cases = [
        { model: "gpt-5.6-terra", input: 2000, tier: "default", expected: 0.07 },
        { model: "gpt-5.6-terra", input: 2001, tier: "default", expected: 0.134004 },
        { model: "gpt-5.6-terra", input: 2001, tier: "priority", expected: 0.268008 },
        { model: "gpt-5.6-luna", input: 2000, tier: "default", expected: 0.007 },
        { model: "gpt-5.6-luna", input: 2001, tier: "default", expected: 0.0134004 },
        { model: "gpt-5.6-luna", input: 2001, tier: "fast", expected: 0.0268008 },
    ];
    for (const item of cases) {
        const event: SpendEvent = {
            source: "codex",
            id: "request",
            model: item.model,
            timestamp: "2026-09-08T00:00:00Z",
            sessionId: "fixture",
            project: "",
            inputTokens: item.input,
            cacheReadTokens: 270000,
            cacheCreationTokens: 0,
            outputTokens: 1000,
            serviceTier: item.tier,
        };
        const quote = catalogEstimate(event, DEFAULT_PRICING, codexDriver.priceCandidates(item.model));
        expect(quote.pricingModel).toBe(item.model);
        expect(quote.costUSD).toBeCloseTo(item.expected, 10);
    }
});
