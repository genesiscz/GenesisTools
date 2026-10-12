import { describe, expect, test } from "bun:test";
import { type LiteLLMModelPricing, LiteLLMPricingFetcher } from "./litellm";

function price(inputPer1M: number, outputPer1M: number): LiteLLMModelPricing {
    return { input_cost_per_token: inputPer1M / 1e6, output_cost_per_token: outputPer1M / 1e6 };
}

function fetcher(models: Record<string, LiteLLMModelPricing>): LiteLLMPricingFetcher {
    return new LiteLLMPricingFetcher({ offline: true, offlineLoader: async () => models });
}

describe("LiteLLMPricingFetcher.getModelPricing", () => {
    test("a provider-routed name falls back to the same model, never to a shorter model it contains", async () => {
        const models = { "gpt-4": price(30, 60), "gpt-4o-mini": price(0.15, 0.6), "gpt-4o": price(2.5, 10) };

        const found = await fetcher(models).getModelPricing("openrouter/openai/gpt-4o");

        expect(found?.input_cost_per_token).toBe(2.5 / 1e6);
    });

    test("a model with no entry of its own is not priced as a different model", async () => {
        const models = { "gpt-4": price(30, 60), "gpt-4o-mini": price(0.15, 0.6) };

        expect(await fetcher(models).getModelPricing("gpt-4o")).toBeNull();
    });

    test("a dated release falls back to its undated entry, and a provider-routed name to a dated entry", async () => {
        const undated = await fetcher({ "gpt-4o": price(2.5, 10) }).getModelPricing("gpt-4o-2024-08-06");
        const dated = await fetcher({ "claude-sonnet-4-5-20250929": price(3, 15) }).getModelPricing(
            "anthropic/claude-sonnet-4-5"
        );

        expect(undated?.input_cost_per_token).toBe(2.5 / 1e6);
        expect(dated?.input_cost_per_token).toBe(3 / 1e6);
    });
});
