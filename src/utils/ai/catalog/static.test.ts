import { describe, expect, test } from "bun:test";
import {
    aliasMapFor,
    byCapability,
    byId,
    byProvider,
    inputModalitiesFor,
    isDatedModelId,
    STATIC_CATALOG,
    staticPricingFor,
    stripModelVariantSuffix,
} from "./static";

describe("static catalog", () => {
    test("ids are unique across providers", () => {
        const ids = STATIC_CATALOG.map((entry) => entry.id);
        const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

        expect(duplicates).toEqual([]);
    });

    test("every provider that used to keep its own list is represented", () => {
        // Anthropic came from models/registry, xai from grok/models plus
        // ai-proxy's XAI_STATIC_CHAT_MODELS, openai-sub from openai/sub-models.
        expect(byProvider("anthropic").length).toBeGreaterThan(0);
        expect(byProvider("xai").length).toBeGreaterThan(0);
        expect(byProvider("openai-sub").length).toBeGreaterThan(0);
        expect(byProvider("nonexistent")).toEqual([]);
    });

    test("entries carry a window and a capability set", () => {
        for (const entry of STATIC_CATALOG) {
            expect(entry.contextWindow).toBeGreaterThan(0);
            expect(entry.capabilities.size).toBeGreaterThan(0);
            expect(entry.source).toBe("static");
        }
    });

    test("lookup resolves both concrete ids and aliases", () => {
        expect(byId("claude-opus-5")?.displayName).toBe("Claude Opus 5");
        expect(byId("opus")?.id).toBe("claude-opus-5");
        expect(byId("sonnet")?.id).toBe("claude-sonnet-5");
        expect(byId("not-a-model")).toBeUndefined();
    });

    test("aliases map per provider and never leak across providers", () => {
        expect(aliasMapFor("anthropic")).toMatchObject({ opus: "claude-opus-5", haiku: "claude-haiku-4-5-20251001" });
        expect(aliasMapFor("xai")).toEqual({});
    });

    test("capability filtering reaches every chat model", () => {
        expect(byCapability("chat").length).toBe(STATIC_CATALOG.length);
        expect(byCapability("image")).toEqual([]);
    });

    /**
     * Absent pricing means unknown, never free — a subscription-only model with
     * a $0 rate would silently report free usage.
     */
    test("pricing is present where committed and absent otherwise", () => {
        expect(staticPricingFor("claude-opus-5")).toEqual({
            inputPer1M: 5,
            outputPer1M: 25,
            cachedCreatePer1M: 6.25,
            cachedReadPer1M: 0.5,
        });
        expect(staticPricingFor("gpt-5.6-sol")).toBeUndefined();
    });

    /**
     * The suffix strip is boundary-anchored on purpose: an open-ended prefix
     * match once billed grok-4.5 at grok-4's rate.
     */
    test("variant suffixes strip only at a real boundary", () => {
        expect(stripModelVariantSuffix("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
        expect(stripModelVariantSuffix("grok-3-fast-latest")).toBe("grok-3-fast");
        expect(stripModelVariantSuffix("grok-4.5")).toBeNull();
        expect(isDatedModelId("claude-sonnet-4-5-20250929")).toBe(true);
        expect(isDatedModelId("claude-sonnet-5")).toBe(false);
    });

    test("input modalities default per provider and deviate per entry", () => {
        const opus = byId("claude-opus-5");
        const grok45 = byId("grok-4.5");
        const grok3 = byId("grok-3");

        expect(opus && inputModalitiesFor(opus)).toEqual(["text", "image"]);
        expect(grok45 && inputModalitiesFor(grok45)).toEqual(["text", "image"]);
        expect(grok3 && inputModalitiesFor(grok3)).toBeUndefined();
    });

    /**
     * The stale-catalog regression this phase exists to prevent: `KNOWN_MODELS`
     * in ask was two Anthropic generations behind and still shipped to users.
     */
    test("the current Anthropic generation is present", () => {
        for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
            expect(byId(id)?.provider).toBe("anthropic");
        }
    });
});
