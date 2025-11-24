#!/usr/bin/env bun
import { dynamicPricingManager } from "./src/ask/providers/DynamicPricing";
import { liteLLMPricingFetcher } from "./src/ask/providers/LiteLLMPricingFetcher";
import type { LanguageModelUsage } from "ai";

async function main() {
    console.log("=== OpenAI GPT-4o Pricing ===\n");
    const gpt4oPricing = await dynamicPricingManager.getPricing("openai", "gpt-4o");
    console.log("Direct OpenAI GPT-4o:", JSON.stringify(gpt4oPricing, null, 2));

    console.log("\n=== OpenAI GPT-4o-mini Pricing ===\n");
    const gpt4oMiniPricing = await dynamicPricingManager.getPricing("openai", "gpt-4o-mini");
    console.log("Direct OpenAI GPT-4o-mini:", JSON.stringify(gpt4oMiniPricing, null, 2));

    console.log("\n=== OpenRouter GPT-4o Pricing ===\n");
    const openRouterGpt4o = await dynamicPricingManager.getPricing("openrouter", "openai/gpt-4o");
    console.log("OpenRouter GPT-4o:", JSON.stringify(openRouterGpt4o, null, 2));

    console.log("\n=== OpenRouter GPT-4o-mini Pricing ===\n");
    const openRouterMini = await dynamicPricingManager.getPricing("openrouter", "openai/gpt-4o-mini");
    console.log("OpenRouter GPT-4o-mini:", JSON.stringify(openRouterMini, null, 2));

    console.log("\n=== Claude 3.5 Sonnet Pricing ===\n");
    const claudePricing = await dynamicPricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");
    console.log("Claude pricing:", JSON.stringify(claudePricing, null, 2));

    console.log("\n=== Cost Calculation Tests ===\n");
    const usage1: LanguageModelUsage = {
        promptTokens: 300_000,
        completionTokens: 250_000,
        totalTokens: 550_000,
    };
    const cost1 = await dynamicPricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage1);
    console.log("Cost for 300k input + 250k output (Claude):", cost1);

    const usage2: LanguageModelUsage = {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
    };
    const cost2 = await dynamicPricingManager.calculateCost("openai", "gpt-4o", usage2);
    console.log("Cost for 1M input + 500k output (GPT-4o):", cost2);

    console.log("\n=== LiteLLM Data ===\n");
    const liteLLMGpt4o = await liteLLMPricingFetcher.getModelPricing("openrouter/openai/gpt-4o");
    console.log("LiteLLM openrouter/openai/gpt-4o:", JSON.stringify(liteLLMGpt4o, null, 2));

    const liteLLMMini = await liteLLMPricingFetcher.getModelPricing("openrouter/openai/gpt-4o-mini");
    console.log("\nLiteLLM openrouter/openai/gpt-4o-mini:", JSON.stringify(liteLLMMini, null, 2));

    const liteLLMClaude = await liteLLMPricingFetcher.getModelPricing("claude-3-5-sonnet-20241022");
    console.log("\nLiteLLM claude-3-5-sonnet-20241022:", JSON.stringify(liteLLMClaude, null, 2));
}

main().catch(console.error);
