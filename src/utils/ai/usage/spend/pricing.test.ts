import { describe, expect, test } from "bun:test";
import { byId } from "@genesiscz/utils/ai/catalog";
import claudeCodeBills from "./fixtures/claude-code-bills.json";
import { costOf, DEFAULT_PRICING, priceFor, resolvePrice } from "./pricing";

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

describe("Claude Code's own bills", () => {
    // Real per-model token sums from 12 local Claude Code sessions (2026-09-08 to 10-12), each next to the costUSD
    // Claude Code itself recorded in that session's `cost-state` line. Only rows whose requests all sit in one price
    // band and one dated rate were kept, so the sum prices like the requests did. Every row's cache writes are
    // one-hour writes, which is what proves the 2x-input rate. Numbers only: no session id, path or content.
    test.each(claudeCodeBills.map((bill) => [bill.model, bill.at, bill] as const))(
        "%s on %s costs what Claude Code billed",
        (model, at, bill) => {
            const entry = priceFor(model, DEFAULT_PRICING);
            expect(entry).not.toBeNull();

            const ours = costOf(bill.tokens, resolvePrice(entry!, { at: new Date(at), contextTokens: 0 }));
            expect(Math.abs(ours - bill.claudeCodeCostUsd) / bill.claudeCodeCostUsd).toBeLessThan(1e-6);
        }
    );
});
