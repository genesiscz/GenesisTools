import { describe, expect, test } from "bun:test";
import { byId } from "@genesiscz/utils/ai/catalog";
import { DEFAULT_PRICING, priceFor } from "./pricing";

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

    test("subscription and CLI-plan ids stay unpriced, so they cost $0", () => {
        expect(DEFAULT_PRICING["grok-4.6"]).toBeUndefined();
        expect(DEFAULT_PRICING["grok-4.6-build"]).toBeUndefined();
        expect(DEFAULT_PRICING["gpt-5.6-sol"]).toBeUndefined();
        expect(DEFAULT_PRICING["codex-auto-review"]).toBeUndefined();
        expect(priceFor("grok-4.6", DEFAULT_PRICING)).toBeNull();
    });

    test("priceFor falls back to the variant-stripped id, never a prefix guess", () => {
        expect(priceFor("gpt-5", DEFAULT_PRICING)?.input).toBe(1.25);
        // A prefix match would resolve this to gpt-5. It must not.
        expect(priceFor("gpt-5-something-invented", DEFAULT_PRICING)).toBeNull();
    });
});
