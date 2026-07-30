import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearPricingCache, convertOpenRouterPricing, pricingCacheSize, pricingFor } from "./pricing";

/**
 * Network is stubbed out: these tests pin the LADDER (which source answers,
 * and for which provider), not live rates. Live-rate verification stays in
 * `DynamicPricing.test.ts`'s network-gated block.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
    clearPricingCache();
    globalThis.fetch = (async () => {
        throw new Error("network disabled in pricing ladder tests");
    }) as unknown as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
    clearPricingCache();
});

describe("pricing ladder", () => {
    test("static answers for the provider that owns the model", async () => {
        const pricing = await pricingFor("anthropic", "claude-opus-5");

        expect(pricing).toEqual({
            inputPer1M: 5,
            outputPer1M: 25,
            cachedCreatePer1M: 6.25,
            cachedReadPer1M: 0.5,
        });
    });

    /**
     * The bug this pins: `pricingFor("openrouter", "claude-opus-5")` used to
     * return Anthropic's direct list price — the wrong vendor's rate for the
     * route actually being billed. A gateway-routed model must resolve through
     * the live feeds (here disabled, so: unknown), never the static entry of a
     * DIFFERENT provider.
     */
    test("a static entry never prices another provider's route", async () => {
        expect(await pricingFor("openrouter", "claude-opus-5")).toBeUndefined();
        expect(await pricingFor("openai", "claude-opus-5")).toBeUndefined();
    });

    test("unknown pricing is undefined, never zero", async () => {
        // gpt-5.6-sol is in the static catalog WITHOUT pricing (subscription
        // model); the ladder must not invent a rate for it.
        expect(await pricingFor("openai-sub", "gpt-5.6-sol")).toBeUndefined();
    });

    test("resolved prices cache; unknown ones are retried", async () => {
        await pricingFor("anthropic", "claude-opus-5");
        expect(pricingCacheSize()).toBe(1);

        await pricingFor("openrouter", "whatever/unknown");
        // Unknown stays uncached so a later run with network can still resolve it.
        expect(pricingCacheSize()).toBe(1);
    });

    test("openrouter per-token quotes convert to per-1M", () => {
        expect(
            convertOpenRouterPricing({ prompt: "0.0000025", completion: 0.00001, cache_read: "0.00000125" })
        ).toEqual({
            inputPer1M: 2.5,
            outputPer1M: 10,
            cachedReadPer1M: 1.25,
        });
        expect(convertOpenRouterPricing({})).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    });
});
