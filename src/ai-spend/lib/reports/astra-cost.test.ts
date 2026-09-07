import { describe, expect, test } from "bun:test";
import { DEFAULT_PRICING } from "../pricing";
import { catalogCost } from "./cost";
import type { SpendEvent } from "./types";

const event = (inputTokens: number, cacheReadTokens: number, outputTokens = 1_000): SpendEvent => ({
    source: "codex",
    id: "request",
    model: "gpt-6-astra",
    timestamp: "2026-09-07T10:00:00Z",
    sessionId: "session",
    project: "",
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cacheCreationTokens: 0,
});

describe("Astra request pricing", () => {
    // Regression: user reported that ccusage's flat Astra total ignores long context.
    test("prices the whole cache-heavy request only above 272000 input tokens", () => {
        const cases = [
            { usage: event(2_000, 270_000), expected: 0.34 },
            { usage: event(2_001, 270_000), expected: 0.65502 },
            { usage: event(10_000, 0, 300_000), expected: 15.1 },
        ];
        for (const { usage, expected } of cases) {
            expect(catalogCost(usage, DEFAULT_PRICING, [usage.model])).toBeCloseTo(expected, 10);
        }
    });
});

test("Astra fast pricing combines with the long-context band and bills cache writes once", () => {
    const usage = { ...event(2_001, 260_000), cacheCreationTokens: 10_000, serviceTier: "fast" };
    expect(catalogCost(usage, DEFAULT_PRICING, [usage.model])).toBeCloseTo(1.77004, 10);
    expect(catalogCost({ ...usage, serviceTier: "priority" }, DEFAULT_PRICING, [usage.model])).toBeCloseTo(1.77004, 10);
    const small = event(100_000, 0);
    expect(catalogCost(small, DEFAULT_PRICING, [small.model]) * 3).toBeCloseTo(3.15, 10);
});

test("Sol uses its own published rates instead of falling back to generic GPT-5.6", () => {
    const small = { ...event(100_000, 0), model: "gpt-5.6-sol" };
    const large = { ...event(2_001, 270_000), model: "gpt-5.6-sol", serviceTier: "fast" };
    const candidates = ["gpt-5.6-sol", "gpt-5.6"];
    expect(catalogCost(small, DEFAULT_PRICING, candidates)).toBeCloseTo(0.42, 10);
    expect(catalogCost(large, DEFAULT_PRICING, candidates)).toBeCloseTo(0.524016, 10);
});
