import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearPricingCache, convertOpenRouterPricing, effectivePricing, pricingCacheSize, pricingFor } from "./pricing";
import { byId } from "./static";
import type { ModelPricing } from "./types";

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
        // Absent means UNKNOWN, never free (the invariant in catalog/types.ts).
        // This used to assert `{inputPer1M: 0, outputPer1M: 0}`, which is a
        // truthy object: it got cached for an hour and booked calls at $0,
        // indistinguishable from a genuinely free model.
        expect(convertOpenRouterPricing({})).toBeUndefined();
        expect(convertOpenRouterPricing({ prompt: "0.0000025" })).toBeUndefined();
    });

    // A real free route quotes "0", which must survive as a priced zero rather
    // than being confused with an absent field.
    test("an explicit zero quote stays a priced zero", () => {
        expect(convertOpenRouterPricing({ prompt: "0", completion: "0" })).toEqual({
            inputPer1M: 0,
            outputPer1M: 0,
        });
    });
});

describe("effectivePricing", () => {
    const base: ModelPricing = { inputPer1M: 3, outputPer1M: 15, cachedReadPer1M: 0.3 };

    test("pricing without rules passes through unchanged", () => {
        expect(effectivePricing(base)).toEqual(base);
        expect(effectivePricing({ ...base, rules: [] }, { at: new Date("2026-07-29") })).toEqual(base);
    });

    test("the resolved price carries no rules, so it cannot be applied twice", () => {
        const withRule: ModelPricing = { ...base, rules: [{ to: "2026-08-31", inputPer1M: 2 }] };
        const resolved = effectivePricing(withRule, { at: new Date("2026-07-29") });

        expect(resolved.rules).toBeUndefined();
        expect(effectivePricing(resolved)).toEqual(resolved);
    });

    test("date windows are inclusive at both ends", () => {
        const promo: ModelPricing = { ...base, rules: [{ from: "2026-08-01", to: "2026-08-31", inputPer1M: 2 }] };
        const on = (day: string) => effectivePricing(promo, { at: new Date(`${day}T12:00:00Z`) }).inputPer1M;

        expect(on("2026-07-31")).toBe(3);
        expect(on("2026-08-01")).toBe(2);
        expect(on("2026-08-31")).toBe(2);
        expect(on("2026-09-01")).toBe(3);
    });

    test("an open-ended window applies on the side it omits", () => {
        const until: ModelPricing = { ...base, rules: [{ to: "2026-08-31", inputPer1M: 2 }] };
        const since: ModelPricing = { ...base, rules: [{ from: "2026-08-01", inputPer1M: 4 }] };

        expect(effectivePricing(until, { at: new Date("2020-01-01") }).inputPer1M).toBe(2);
        expect(effectivePricing(since, { at: new Date("2099-01-01") }).inputPer1M).toBe(4);
    });

    test("context bands are inclusive and only apply when the size is known", () => {
        const tiered: ModelPricing = { ...base, rules: [{ ctxFrom: 200_001, inputPer1M: 6 }] };

        expect(effectivePricing(tiered, { contextTokens: 200_000 }).inputPer1M).toBe(3);
        expect(effectivePricing(tiered, { contextTokens: 200_001 }).inputPer1M).toBe(6);
        // No token count given: the surcharge cannot be justified, so it is not charged.
        expect(effectivePricing(tiered).inputPer1M).toBe(3);
    });

    test("an upper context bound closes the band", () => {
        const banded: ModelPricing = { ...base, rules: [{ ctxFrom: 100, ctxTo: 200, inputPer1M: 9 }] };

        expect(effectivePricing(banded, { contextTokens: 99 }).inputPer1M).toBe(3);
        expect(effectivePricing(banded, { contextTokens: 100 }).inputPer1M).toBe(9);
        expect(effectivePricing(banded, { contextTokens: 200 }).inputPer1M).toBe(9);
        expect(effectivePricing(banded, { contextTokens: 201 }).inputPer1M).toBe(3);
    });

    test("a dated rule needs a date, or it does not apply", () => {
        const promo: ModelPricing = { ...base, rules: [{ to: "2026-08-31", inputPer1M: 2 }] };

        expect(effectivePricing(promo).inputPer1M).toBe(3);
    });

    test("a rule overrides only the fields it names", () => {
        const promo: ModelPricing = { ...base, rules: [{ to: "2026-08-31", inputPer1M: 2 }] };
        const resolved = effectivePricing(promo, { at: new Date("2026-07-29") });

        expect(resolved.inputPer1M).toBe(2);
        expect(resolved.outputPer1M).toBe(15);
        expect(resolved.cachedReadPer1M).toBe(0.3);
    });

    test("later matching rules win field by field", () => {
        const stacked: ModelPricing = {
            ...base,
            rules: [
                { ctxFrom: 200_001, inputPer1M: 6, outputPer1M: 22.5 },
                { to: "2026-08-31", inputPer1M: 2 },
            ],
        };
        const resolved = effectivePricing(stacked, { at: new Date("2026-07-29"), contextTokens: 300_000 });

        // The promo, being later, wins input; the tier still owns output.
        expect(resolved.inputPer1M).toBe(2);
        expect(resolved.outputPer1M).toBe(22.5);
    });

    test("window and band on one rule must BOTH match", () => {
        const both: ModelPricing = { ...base, rules: [{ to: "2026-08-31", ctxFrom: 200_001, inputPer1M: 7 }] };

        expect(effectivePricing(both, { at: new Date("2026-07-29"), contextTokens: 300_000 }).inputPer1M).toBe(7);
        expect(effectivePricing(both, { at: new Date("2026-09-29"), contextTokens: 300_000 }).inputPer1M).toBe(3);
        expect(effectivePricing(both, { at: new Date("2026-07-29"), contextTokens: 1_000 }).inputPer1M).toBe(3);
    });
});

describe("catalog entries carrying rules", () => {
    /** The user's chosen resolution: the discount expires on its own date. */
    test("Sonnet 5 bills the intro rate inside the window and list price after", () => {
        const pricing = byId("claude-sonnet-5", "anthropic")?.pricing;

        if (!pricing) {
            throw new Error("claude-sonnet-5 is missing from the catalog");
        }

        const intro = effectivePricing(pricing, { at: new Date("2026-07-29T12:00:00Z") });
        expect(intro.inputPer1M).toBe(2);
        expect(intro.outputPer1M).toBe(10);

        const listed = effectivePricing(pricing, { at: new Date("2026-09-01T00:00:00Z") });
        expect(listed.inputPer1M).toBe(3);
        expect(listed.outputPer1M).toBe(15);

        // The intro price never touched the cache rates.
        expect(intro.cachedReadPer1M).toBe(0.3);
        expect(intro.cachedCreatePer1M).toBe(3.75);
    });

    /**
     * The compat fields and the rule describe the same surcharge, so they must
     * never drift apart — this fails the moment someone edits one of them alone.
     */
    test("Sonnet 4.5's context rule agrees with its Above200k fields", () => {
        const pricing = byId("claude-sonnet-4-5-20250929", "anthropic")?.pricing;

        if (!pricing) {
            throw new Error("claude-sonnet-4-5-20250929 is missing from the catalog");
        }

        const long = effectivePricing(pricing, { contextTokens: 300_000 });

        // Compared as a whole so the check cannot pass by both sides being
        // undefined, which is how a consistency assertion quietly goes vacuous.
        expect({
            input: long.inputPer1M,
            output: long.outputPer1M,
            cachedRead: long.cachedReadPer1M,
            cachedCreate: long.cachedCreatePer1M,
        }).toEqual({
            input: 6,
            output: 22.5,
            cachedRead: 0.6,
            cachedCreate: 7.5,
        });
        expect({
            input: pricing.inputPer1MAbove200k,
            output: pricing.outputPer1MAbove200k,
            cachedRead: pricing.cachedReadPer1MAbove200k,
            cachedCreate: pricing.cachedCreatePer1MAbove200k,
        }).toEqual({
            input: 6,
            output: 22.5,
            cachedRead: 0.6,
            cachedCreate: 7.5,
        });

        // Below the threshold it is the plain Sonnet rate.
        expect(effectivePricing(pricing, { contextTokens: 200_000 }).inputPer1M).toBe(3);
    });

    test("models with no conditional pricing resolve to their base rate", () => {
        const opus = byId("claude-opus-5", "anthropic")?.pricing;

        if (!opus) {
            throw new Error("claude-opus-5 is missing from the catalog");
        }

        expect(effectivePricing(opus, { at: new Date("2026-07-29"), contextTokens: 900_000 })).toEqual(opus);
    });
});
