import { describe, expect, test } from "bun:test";
import { byId } from "@genesiscz/utils/ai/catalog";
import { DEFAULT_PRICING, priceFor, resolvePrice } from "./pricing";
import { eventCostEstimate } from "./reports/cost";
import type { SpendEvent } from "./reports/types";

describe("pricing table", () => {
    test("anthropic and openai rates are billable", () => {
        expect(DEFAULT_PRICING["gpt-5.6"]).toEqual({ input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 });
        expect(DEFAULT_PRICING["gpt-5"]).toEqual({
            input: 1.25,
            output: 10,
            cacheWrite: 1.25 * 1.25,
            cacheRead: 0.125,
        });
        expect(DEFAULT_PRICING["claude-3-5-haiku"]).toEqual({
            input: 0.8,
            output: 4,
            cacheWrite: 1.0,
            cacheWrite1h: 1.6,
            cacheRead: 0.08,
        });
    });

    test("claude-3-5-haiku is a hidden CATALOG entry now, not a literal table in pricing.ts", () => {
        // It used to be `LEGACY_PRICING`, four numbers written out here. Hidden
        // keeps it out of the pickers while `byProvider("anthropic")` still
        // feeds it to the spend table, which is the only consumer left.
        const entry = byId("claude-3-5-haiku", "anthropic");

        expect(entry?.flags?.hidden).toBe(true);
        expect(entry?.pricing).toMatchObject({ inputPer1M: 0.8, outputPer1M: 4 });
    });

    test("an unpriced catalog entry never shadows a priced id of the same name", () => {
        // `openai-sub` also carries gpt-5.4, with no rates. The `openai` entry wins.
        expect(DEFAULT_PRICING["gpt-5.4"]?.input).toBe(2.5);
    });

    test("models without published API rates stay unpriced", () => {
        // grok-composer-2.5-fast runs only inside Grok Build; xAI publishes no API rate for it.
        expect(DEFAULT_PRICING["grok-composer-2.5-fast"]).toBeUndefined();
        expect(DEFAULT_PRICING["grok-4.6-build"]).toBeUndefined();
        expect(priceFor("gpt-5.6-sol", DEFAULT_PRICING)).not.toBeNull();
        expect(DEFAULT_PRICING["codex-auto-review"]).toBeUndefined();
        expect(priceFor("grok-composer-2.5-fast", DEFAULT_PRICING)).toBeNull();
    });

    test("xAI list rates, with the long-context band from the prompt that REACHES 200k", () => {
        // docs.x.ai/developers/pricing, read 2026-10-14. A cache write bills as plain input.
        expect(DEFAULT_PRICING["grok-4.6"]).toMatchObject({ input: 2, cacheRead: 0.5, output: 6, cacheWrite: 2 });
        expect(DEFAULT_PRICING["grok-4.3"]).toMatchObject({ input: 1.25, cacheRead: 0.2, output: 2.5 });
        const grok47 = priceFor("grok-4.7", DEFAULT_PRICING);

        if (!grok47) {
            throw new Error("grok-4.7 has no price");
        }

        expect(resolvePrice(grok47, { contextTokens: 199_999 })).toMatchObject({ input: 2, cacheRead: 0.5, output: 6 });
        expect(resolvePrice(grok47, { contextTokens: 200_000 })).toMatchObject({ input: 4, cacheRead: 1, output: 12 });
        expect(resolvePrice(grok47, { serviceTier: "priority" })).toMatchObject({ input: 4, cacheRead: 1, output: 12 });

        // The Fast section says the band applies once a prompt EXCEEDS 200k.
        const fast = priceFor("grok-4.7-build-fast", DEFAULT_PRICING);

        if (!fast) {
            throw new Error("grok-4.7-build-fast has no price");
        }

        expect(resolvePrice(fast, { contextTokens: 200_000 })).toMatchObject({ input: 4, cacheRead: 1, output: 12 });
        expect(resolvePrice(fast, { contextTokens: 200_001 })).toMatchObject({ input: 6, cacheRead: 1.5, output: 18 });
    });

    test("priceFor falls back to the variant-stripped id, never a prefix guess", () => {
        expect(priceFor("gpt-5", DEFAULT_PRICING)?.input).toBe(1.25);
        // A prefix match would resolve this to gpt-5. It must not.
        expect(priceFor("gpt-5-something-invented", DEFAULT_PRICING)).toBeNull();
    });
});

describe("what a recorded cost means", () => {
    // 1M fresh input, 1M cached, 100K output: grok-4.7 at list is $2 + $0.50 + $0.60.
    const turn = (overrides: Partial<SpendEvent> = {}): SpendEvent => ({
        source: "grok",
        id: "turn-1",
        model: "grok-4.7",
        timestamp: "2026-10-13T10:00:00Z",
        sessionId: "s",
        project: "",
        inputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 0,
        outputTokens: 100_000,
        recordedCostUsd: 1.05,
        // A grok turn row sums its model calls.
        aggregate: true,
        ...overrides,
    });

    test("grok's recorded figure is its plan metering, so the list price wins", () => {
        expect(eventCostEstimate(turn(), DEFAULT_PRICING, "auto", ["grok-4.7"])).toMatchObject({
            costUSD: 3.1,
            basis: "catalog",
        });
    });

    test("grok's figure stands in, labelled reported, only for a model without a list price", () => {
        const unpriced = turn({ model: "grok-0-unpriced" });

        expect(eventCostEstimate(unpriced, DEFAULT_PRICING, "auto", ["grok-0-unpriced"])).toEqual({
            costUSD: 1.05,
            longContext: false,
            basis: "reported",
        });
        expect(eventCostEstimate(unpriced, DEFAULT_PRICING, "calculate", ["grok-0-unpriced"]).costUSD).toBeNull();
        expect(eventCostEstimate(turn(), DEFAULT_PRICING, "display", ["grok-4.7"]).basis).toBe("reported");
    });

    test("a recorded cost that IS the list price still wins in auto mode", () => {
        const codex = turn({ source: "codex", model: "gpt-5.6", recordedCostUsd: 0.12 });

        expect(eventCostEstimate(codex, DEFAULT_PRICING, "auto", ["gpt-5.6"])).toMatchObject({
            costUSD: 0.12,
            basis: "recorded",
        });
    });

    test("a turn that sums several requests prices at the base band, never at the band of the sum", () => {
        const single = eventCostEstimate(
            turn({ recordedCostUsd: undefined, aggregate: undefined }),
            DEFAULT_PRICING,
            "auto",
            ["grok-4.7"]
        );
        const summed = eventCostEstimate(turn({ recordedCostUsd: undefined }), DEFAULT_PRICING, "auto", ["grok-4.7"]);

        // 2M tokens in one request crosses the 200k band ($4 / $1 / $12); 37 requests summed do not.
        expect(single).toMatchObject({ costUSD: 6.2, longContext: true });
        expect(summed).toMatchObject({ costUSD: 3.1, longContext: false });
    });

    test("a one-hour cache write bills at 2x input, a five-minute one at 1.25x", () => {
        const write = turn({
            source: "claude",
            model: "claude-opus-5",
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 1_000_000,
            recordedCostUsd: undefined,
        });

        expect(eventCostEstimate(write, DEFAULT_PRICING, "auto", ["claude-opus-5"]).costUSD).toBeCloseTo(6.25, 10);
        expect(
            eventCostEstimate({ ...write, cacheCreation1hTokens: 400_000 }, DEFAULT_PRICING, "auto", ["claude-opus-5"])
                .costUSD
        ).toBeCloseTo(0.6 * 6.25 + 0.4 * 10, 10);
    });
});
