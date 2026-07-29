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

    /**
     * Sonnet 4.5 bills >200K context at double, and the static entry is what
     * answers for a dated id — so if the tier fields are missing here, every
     * long-context estimate for that model is half the real cost.
     */
    test("the long-context tier survives the ladder for a dated sonnet id", async () => {
        const pricing = await pricingFor("anthropic", "claude-sonnet-4-5-20250929");

        expect(pricing?.inputPer1MAbove200k).toBe(6);
        expect(pricing?.outputPer1MAbove200k).toBe(22.5);
        expect(pricing?.cachedCreatePer1MAbove200k).toBe(7.5);
        expect(pricing?.cachedReadPer1MAbove200k).toBe(0.6);
        // Base rates are untouched by the tier.
        expect(pricing?.inputPer1M).toBe(3);
        expect(pricing?.outputPer1M).toBe(15);
    });

    /**
     * The inverse, and the reason this is not a blanket "every Sonnet is
     * tiered": Anthropic serves 1M context at standard rates from 4.6 on, so
     * asserting a surcharge there would over-bill by 2x.
     */
    test("models Anthropic serves at flat 1M pricing carry no tier", async () => {
        for (const id of ["claude-sonnet-4-6", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
            const pricing = await pricingFor("anthropic", id);

            expect(pricing?.inputPer1MAbove200k).toBeUndefined();
            expect(pricing?.outputPer1MAbove200k).toBeUndefined();
        }
    });

    /**
     * Same id, two products, two rates: the Codex-subscription `gpt-5.4` carries
     * no per-token price while the OpenAI API model does. Resolving the wrong
     * one silently prices a paid API call at nothing.
     */
    test("a shared id is priced by the provider being billed", async () => {
        expect(await pricingFor("openai", "gpt-5.4")).toEqual({
            inputPer1M: 2.5,
            outputPer1M: 15,
            cachedReadPer1M: 0.25,
        });
        expect(await pricingFor("openai-sub", "gpt-5.4")).toBeUndefined();
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
