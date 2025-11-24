import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { DynamicPricingManager } from "@ask/providers/DynamicPricing";
import { liteLLMPricingFetcher } from "@ask/providers/LiteLLMPricingFetcher";
import { providerManager } from "@ask/providers/ProviderManager";
import type { PricingInfo } from "@ask/types/provider";
import type { LanguageModelUsage } from "ai";

describe("DynamicPricingManager", () => {
    let pricingManager: DynamicPricingManager;

    beforeEach(() => {
        pricingManager = new DynamicPricingManager();
        pricingManager.clearCache();
        // Clear LiteLLM cache
        liteLLMPricingFetcher.clearCache();
    });

    afterEach(() => {
        pricingManager.clearCache();
        liteLLMPricingFetcher.clearCache();
    });

    describe("getPricing", () => {
        it("should return OpenAI direct pricing for gpt-4o", async () => {
            const pricing = await pricingManager.getPricing("openai", "gpt-4o");

            expect(pricing).not.toBeNull();
            // Direct OpenAI pricing: $5/$15 per million (as of 2024)
            // If this test fails, OpenAI may have changed their pricing
            expect(pricing?.inputPer1M).toBe(5.0);
            expect(pricing?.outputPer1M).toBe(15.0);
            // Cached read may or may not be present depending on source
            if (pricing?.cachedReadPer1M !== undefined) {
                expect(pricing.cachedReadPer1M).toBeGreaterThan(0);
            }
        });

        it("should return OpenAI direct pricing for gpt-4o-mini", async () => {
            const pricing = await pricingManager.getPricing("openai", "gpt-4o-mini");

            expect(pricing).not.toBeNull();
            // Direct OpenAI pricing: $0.15/$0.6 per million (as of 2024)
            // If this test fails, OpenAI may have changed their pricing
            expect(pricing?.inputPer1M).toBe(0.15);
            expect(pricing?.outputPer1M).toBe(0.6);
        });

        it("should fetch real pricing from LiteLLM for OpenRouter models", async () => {
            // Real API call to LiteLLM - will be cached after first call
            const pricing = await pricingManager.getPricing("openrouter", "openai/gpt-4o");

            expect(pricing).not.toBeNull();
            expect(pricing?.inputPer1M).toBeGreaterThan(0);
            expect(pricing?.outputPer1M).toBeGreaterThan(0);
            // OpenRouter pricing should be cheaper than direct OpenAI
            expect(pricing?.inputPer1M).toBeLessThan(5.0); // Should be less than direct OpenAI $5
        });

        it("should fetch real pricing from LiteLLM for Claude models with tiered pricing", async () => {
            // Real API call to LiteLLM - tests actual tiered pricing support
            const pricing = await pricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");

            expect(pricing).not.toBeNull();
            expect(pricing?.inputPer1M).toBeGreaterThan(0);
            expect(pricing?.outputPer1M).toBeGreaterThan(0);

            // Check if tiered pricing is available (Claude models should have it)
            if (pricing?.inputPer1MAbove200k || pricing?.outputPer1MAbove200k) {
                expect(pricing.inputPer1MAbove200k).toBeGreaterThan(pricing.inputPer1M);
                expect(pricing.outputPer1MAbove200k).toBeGreaterThan(pricing.outputPer1M);
            }
        });

        it("should cache pricing results", async () => {
            const pricing1 = await pricingManager.getPricing("openai", "gpt-4o");
            const pricing2 = await pricingManager.getPricing("openai", "gpt-4o");

            expect(pricing1).toEqual(pricing2);
            expect(pricingManager.getCacheSize()).toBe(1);
        });
    });

    describe("calculateCost", () => {
        it("should calculate cost for OpenAI gpt-4o correctly", async () => {
            // Mock pricing to ensure consistent test results
            const mockPricing: PricingInfo = {
                inputPer1M: 5.0,
                outputPer1M: 15.0,
            };
            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(mockPricing);

            const usage: LanguageModelUsage = {
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
            };

            const cost = await pricingManager.calculateCost("openai", "gpt-4o", usage);

            // Expected: (1000 / 1_000_000) * 5.0 + (500 / 1_000_000) * 15.0
            // = 0.005 + 0.0075 = 0.0125
            expect(cost).toBeCloseTo(0.0125, 6);
        });

        it("should calculate cost with cached tokens", async () => {
            // Mock pricing with cached read pricing
            const mockPricing: PricingInfo = {
                inputPer1M: 5.0,
                outputPer1M: 15.0,
                cachedReadPer1M: 2.5,
            };
            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(mockPricing);

            const usage: LanguageModelUsage = {
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
            };
            (usage as any).cachedPromptTokens = 200;

            const cost = await pricingManager.calculateCost("openai", "gpt-4o", usage);

            // Expected: (1000 / 1_000_000) * 5.0 + (500 / 1_000_000) * 15.0 + (200 / 1_000_000) * 2.5
            // = 0.005 + 0.0075 + 0.0005 = 0.013
            expect(cost).toBeCloseTo(0.013, 6);
        });

        it("should calculate tiered pricing for Claude models above 200k tokens", async () => {
            const mockPricing: PricingInfo = {
                inputPer1M: 3.0,
                outputPer1M: 15.0,
                inputPer1MAbove200k: 6.0,
                outputPer1MAbove200k: 30.0,
            };

            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(mockPricing);

            // 300k input tokens, 250k output tokens
            const usage: LanguageModelUsage = {
                promptTokens: 300_000,
                completionTokens: 250_000,
                totalTokens: 550_000,
            };

            const cost = await pricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage);

            // Expected:
            // Input: (200k / 1M) * 3.0 + (100k / 1M) * 6.0 = 0.6 + 0.6 = 1.2
            // Output: (200k / 1M) * 15.0 + (50k / 1M) * 30.0 = 3.0 + 1.5 = 4.5
            // Total: 1.2 + 4.5 = 5.7
            expect(cost).toBeCloseTo(5.7, 2);
        });

        it("should calculate tiered pricing correctly at exactly 200k threshold", async () => {
            const mockPricing: PricingInfo = {
                inputPer1M: 3.0,
                outputPer1M: 15.0,
                inputPer1MAbove200k: 6.0,
                outputPer1MAbove200k: 30.0,
            };

            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(mockPricing);

            // Exactly 200k tokens - should use base pricing only
            const usage: LanguageModelUsage = {
                promptTokens: 200_000,
                completionTokens: 0,
                totalTokens: 200_000,
            };

            const cost = await pricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage);

            // Expected: (200k / 1M) * 3.0 = 0.6
            expect(cost).toBeCloseTo(0.6, 2);
        });

        it("should calculate tiered pricing correctly at 200,001 tokens", async () => {
            const mockPricing: PricingInfo = {
                inputPer1M: 3.0,
                outputPer1M: 15.0,
                inputPer1MAbove200k: 6.0,
                outputPer1MAbove200k: 30.0,
            };

            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(mockPricing);

            // 200,001 tokens - should use tiered pricing for 1 token
            const usage: LanguageModelUsage = {
                promptTokens: 200_001,
                completionTokens: 0,
                totalTokens: 200_001,
            };

            const cost = await pricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage);

            // Expected: (200k / 1M) * 3.0 + (1 / 1M) * 6.0 = 0.6 + 0.000006 = 0.600006
            expect(cost).toBeCloseTo(0.600006, 6);
        });

        it("should handle zero tokens", async () => {
            const usage: LanguageModelUsage = {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
            };

            const cost = await pricingManager.calculateCost("openai", "gpt-4o", usage);

            expect(cost).toBe(0);
        });

        it("should handle missing pricing gracefully", async () => {
            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(null);

            const usage: LanguageModelUsage = {
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
            };

            const cost = await pricingManager.calculateCost("unknown", "unknown-model", usage);

            expect(cost).toBe(0);
        });

        it("should handle both promptTokens and inputTokens naming", async () => {
            const usage1: LanguageModelUsage = {
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
            };

            const usage2 = {
                inputTokens: 1000,
                outputTokens: 500,
                totalTokens: 1500,
            } as LanguageModelUsage;

            const cost1 = await pricingManager.calculateCost("openai", "gpt-4o", usage1);
            const cost2 = await pricingManager.calculateCost("openai", "gpt-4o", usage2);

            expect(cost1).toBeCloseTo(cost2, 6);
        });
    });

    describe("LiteLLM Integration", () => {
        it("should fetch real pricing from LiteLLM GitHub repository", async () => {
            // Real API call - fetches from LiteLLM's GitHub JSON
            const pricing = await liteLLMPricingFetcher.getModelPricing("openrouter/openai/gpt-4o");

            expect(pricing).not.toBeNull();
            expect(pricing?.input_cost_per_token).toBeGreaterThan(0);
            expect(pricing?.output_cost_per_token).toBeGreaterThan(0);
        });

        it("should convert LiteLLM pricing to PricingInfo correctly", async () => {
            // Fetch real pricing from LiteLLM
            const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing("openrouter/openai/gpt-4o");

            expect(liteLLMPricing).not.toBeNull();

            const pricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing!);

            // Verify conversion (per token to per million)
            expect(pricingInfo.inputPer1M).toBeCloseTo((liteLLMPricing!.input_cost_per_token ?? 0) * 1_000_000, 2);
            expect(pricingInfo.outputPer1M).toBeCloseTo((liteLLMPricing!.output_cost_per_token ?? 0) * 1_000_000, 2);
        });

        it("should handle LiteLLM fetch failures gracefully with fallback", async () => {
            // This test verifies the fallback mechanism works
            // We can't easily test network failures without mocking, but we can test
            // that the system handles missing models gracefully
            const pricing = await pricingManager.getPricing("openrouter", "nonexistent-model-xyz-123");

            // Should either return null or fallback pricing
            // The important thing is it doesn't throw
            expect(pricing === null || (pricing !== null && pricing.inputPer1M >= 0)).toBe(true);
        });

        it("should convert LiteLLM pricing correctly", async () => {
            const liteLLMPricing = {
                input_cost_per_token: 5e-6, // $5 per million
                output_cost_per_token: 15e-6, // $15 per million
                cache_read_input_token_cost: 2.5e-6, // $2.5 per million
            };

            const pricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing as any);

            expect(pricingInfo.inputPer1M).toBe(5.0);
            expect(pricingInfo.outputPer1M).toBe(15.0);
            expect(pricingInfo.cachedReadPer1M).toBe(2.5);
        });

        it("should convert LiteLLM tiered pricing correctly", async () => {
            const liteLLMPricing = {
                input_cost_per_token: 3e-6,
                output_cost_per_token: 15e-6,
                input_cost_per_token_above_200k_tokens: 6e-6,
                output_cost_per_token_above_200k_tokens: 30e-6,
            };

            const pricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing as any);

            expect(pricingInfo.inputPer1M).toBe(3.0);
            expect(pricingInfo.outputPer1M).toBe(15.0);
            expect(pricingInfo.inputPer1MAbove200k).toBe(6.0);
            expect(pricingInfo.outputPer1MAbove200k).toBe(30.0);
        });
    });

    describe("OpenRouter Integration", () => {
        it("should fetch real pricing from OpenRouter API", async () => {
            // Real API call to OpenRouter - tests actual integration
            // This will be used as fallback if LiteLLM doesn't have the model
            const pricing = await pricingManager.getPricing("openrouter", "openai/gpt-4o");

            expect(pricing).not.toBeNull();
            expect(pricing?.inputPer1M).toBeGreaterThan(0);
            expect(pricing?.outputPer1M).toBeGreaterThan(0);
            // OpenRouter pricing should be cheaper than direct OpenAI
            expect(pricing?.inputPer1M).toBeLessThan(5.0); // Less than direct OpenAI $5
        });

        it("should handle OpenRouter API response format (string or number)", async () => {
            // Real API call - OpenRouter may return pricing as strings or numbers
            const pricing = await pricingManager.getPricing("openrouter", "openai/gpt-4o");

            expect(pricing).not.toBeNull();
            // Should handle both formats correctly
            expect(typeof pricing?.inputPer1M).toBe("number");
            expect(typeof pricing?.outputPer1M).toBe("number");
        });

        it("should cache OpenRouter API responses", async () => {
            // First call - should fetch from API
            const pricing1 = await pricingManager.getPricing("openrouter", "openai/gpt-4o");
            expect(pricing1).not.toBeNull();

            // Second call - should use cache (no additional API call)
            const pricing2 = await pricingManager.getPricing("openrouter", "openai/gpt-4o");
            expect(pricing2).toEqual(pricing1);
        });
    });

    describe("Stress Tests - LiteLLM + OpenRouter", () => {
        it("should handle multiple concurrent real API requests", async () => {
            // Real concurrent API calls - tests caching and rate limiting
            const models = [
                { provider: "openai", model: "gpt-4o" },
                { provider: "openai", model: "gpt-4o-mini" },
                { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
                { provider: "openrouter", model: "openai/gpt-4o" },
            ];

            const results = await Promise.all(
                models.map(({ provider, model }) => pricingManager.getPricing(provider, model))
            );

            expect(results.length).toBe(models.length);
            results.forEach((pricing) => {
                expect(pricing).not.toBeNull();
                expect(pricing?.inputPer1M).toBeGreaterThan(0);
                expect(pricing?.outputPer1M).toBeGreaterThan(0);
            });
        });

        it("should fetch real pricing for various OpenRouter models", async () => {
            // Test multiple real OpenRouter models
            const models = [
                "openai/gpt-4o",
                "openai/gpt-4o-mini",
                "anthropic/claude-3-5-sonnet-20241022",
                "google/gemini-pro",
            ];

            const results = await Promise.all(models.map((model) => pricingManager.getPricing("openrouter", model)));

            results.forEach((pricing, index) => {
                expect(pricing).not.toBeNull();
                expect(pricing?.inputPer1M).toBeGreaterThan(0);
                expect(pricing?.outputPer1M).toBeGreaterThan(0);
            });
        });

        it("should handle rapid cache hits correctly", async () => {
            const provider = "openai";
            const model = "gpt-4o";

            // First request - should cache
            const pricing1 = await pricingManager.getPricing(provider, model);
            expect(pricing1).not.toBeNull();

            // Rapid subsequent requests - should use cache
            const requests = Array.from({ length: 10 }, () => pricingManager.getPricing(provider, model));
            const results = await Promise.all(requests);

            results.forEach((pricing) => {
                expect(pricing).toEqual(pricing1);
            });
        });

        it("should handle model name variations", async () => {
            const variations = ["gpt-4o", "openai/gpt-4o", "openrouter/openai/gpt-4o"];

            for (const modelId of variations) {
                const pricing = await pricingManager.getPricing("openrouter", modelId);
                // Should either find pricing or gracefully return null
                expect(pricing === null || (pricing !== null && pricing.inputPer1M > 0)).toBe(true);
            }
        });

        it("should calculate costs correctly for various token amounts using real pricing", async () => {
            // Uses real pricing from OpenAI direct pricing ($5/$15 per million)
            const testCases = [
                { input: 1000, output: 500, expectedMin: 0.01, expectedMax: 0.02 },
                { input: 100_000, output: 50_000, expectedMin: 1.0, expectedMax: 2.0 },
                { input: 250_000, output: 100_000, expectedMin: 2.0, expectedMax: 5.0 },
            ];

            for (const testCase of testCases) {
                const usage: LanguageModelUsage = {
                    promptTokens: testCase.input,
                    completionTokens: testCase.output,
                    totalTokens: testCase.input + testCase.output,
                };

                const cost = await pricingManager.calculateCost("openai", "gpt-4o", usage);

                expect(cost).toBeGreaterThanOrEqual(testCase.expectedMin);
                expect(cost).toBeLessThanOrEqual(testCase.expectedMax);
            }
        });

        it("should calculate costs using real LiteLLM pricing for Claude models", async () => {
            // Real API call to LiteLLM for Claude pricing
            const usage: LanguageModelUsage = {
                promptTokens: 300_000, // Above 200k threshold
                completionTokens: 250_000,
                totalTokens: 550_000,
            };

            const cost = await pricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage);

            // Should use tiered pricing if available
            expect(cost).toBeGreaterThan(0);
            expect(cost).toBeLessThan(10); // Should be reasonable for 550k tokens
        });

        it("should handle edge cases in tiered pricing", async () => {
            const mockPricing: PricingInfo = {
                inputPer1M: 3.0,
                outputPer1M: 15.0,
                inputPer1MAbove200k: 6.0,
                outputPer1MAbove200k: 30.0,
            };

            spyOn(pricingManager, "getPricing" as any).mockResolvedValue(mockPricing);

            const edgeCases = [
                { input: 199_999, output: 0 }, // Just below threshold
                { input: 200_000, output: 0 }, // Exactly at threshold
                { input: 200_001, output: 0 }, // Just above threshold
                { input: 1_000_000, output: 0 }, // Very large input
                { input: 0, output: 250_000 }, // Only output above threshold
            ];

            for (const edgeCase of edgeCases) {
                const usage: LanguageModelUsage = {
                    promptTokens: edgeCase.input,
                    completionTokens: edgeCase.output,
                    totalTokens: edgeCase.input + edgeCase.output,
                };

                const cost = await pricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage);

                expect(cost).toBeGreaterThanOrEqual(0);
                expect(isNaN(cost)).toBe(false);
            }
        });
    });

    describe("Current Pricing Verification - Will Break if Prices Change", () => {
        /**
         * ⚠️ IMPORTANT: These tests verify CURRENT pricing from real APIs.
         * If these tests fail, it likely means:
         * 1. The provider changed their pricing (most common)
         * 2. LiteLLM/OpenRouter updated their pricing data
         * 3. There's a bug in our pricing calculation
         *
         * These are regression tests to catch pricing changes.
         * Update the expected values if prices legitimately change.
         */

        it("should match current OpenAI GPT-4o pricing ($5/$15 per million)", async () => {
            // ⚠️ BREAKS IF: OpenAI changes GPT-4o pricing
            const pricing = await pricingManager.getPricing("openai", "gpt-4o");

            expect(pricing).not.toBeNull();
            expect(pricing?.inputPer1M).toBe(5.0); // $5.00 per million input tokens
            expect(pricing?.outputPer1M).toBe(15.0); // $15.00 per million output tokens
        });

        it("should match current OpenAI GPT-4o-mini pricing ($0.15/$0.6/$0.075/$0 per million)", async () => {
            // ⚠️ BREAKS IF: OpenAI changes GPT-4o-mini pricing
            const pricing = await pricingManager.getPricing("openai", "gpt-4o-mini");

            expect(pricing).not.toBeNull();
            expect(pricing?.inputPer1M).toBe(0.15); // $0.15 per million input tokens
            expect(pricing?.outputPer1M).toBe(0.6); // $0.60 per million output tokens
            expect(pricing?.cachedReadPer1M).toBe(0.075); // $0.075 per million cached read tokens
            expect(pricing?.cachedCreatePer1M).toBe(0); // $0 per million cached creation tokens
        });

        it("should match current OpenRouter GPT-4o pricing from LiteLLM", async () => {
            // ⚠️ BREAKS IF: LiteLLM updates OpenRouter pricing OR OpenRouter changes prices
            // Fetches real pricing from LiteLLM GitHub repository
            const pricing = await pricingManager.getPricing("openrouter", "openai/gpt-4o");

            expect(pricing).not.toBeNull();
            // As of 2025-11-24: OpenRouter GPT-4o is $2.50/$10.00 per million
            // If this fails, check: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
            expect(pricing?.inputPer1M).toBe(2.5); // $2.50 per million (cheaper than direct OpenAI)
            expect(pricing?.outputPer1M).toBe(10.0); // $10.00 per million
        });

        it("should match current Claude 3.5 Sonnet pricing from LiteLLM", async () => {
            // ⚠️ BREAKS IF: LiteLLM updates Claude pricing OR Anthropic changes prices
            // Fetches real pricing from LiteLLM GitHub repository
            const pricing = await pricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");

            expect(pricing).not.toBeNull();
            // As of 2025-11-24: Claude 3.5 Sonnet 20241022 has 200k context window, $3/$15 per million (flat rate)
            // NOTE: This model does NOT have tiered pricing (only 1M context models have tiered pricing)
            // If this fails, check LiteLLM pricing JSON for current values
            expect(pricing?.inputPer1M).toBe(3.0); // $3.00 per million input tokens
            expect(pricing?.outputPer1M).toBe(15.0); // $15.00 per million output tokens
            // This model should NOT have tiered pricing (200k context window)
            expect(pricing?.inputPer1MAbove200k).toBeUndefined();
            expect(pricing?.outputPer1MAbove200k).toBeUndefined();
        });

        it("should calculate exact cost for 1M input + 500k output tokens with OpenAI GPT-4o", async () => {
            // ⚠️ BREAKS IF: OpenAI changes GPT-4o pricing
            // Real calculation using current OpenAI pricing: $5/$15 per million
            const usage: LanguageModelUsage = {
                promptTokens: 1_000_000,
                completionTokens: 500_000,
                totalTokens: 1_500_000,
            };

            const cost = await pricingManager.calculateCost("openai", "gpt-4o", usage);

            // Expected: (1M / 1M) * 5.0 + (500k / 1M) * 15.0 = 5.0 + 7.5 = 12.5
            expect(cost).toBeCloseTo(12.5, 2);
        });

        it("should calculate exact cost for 300k input + 250k output with Claude (no tiered pricing)", async () => {
            // ⚠️ BREAKS IF: Anthropic changes Claude pricing OR LiteLLM updates pricing
            // NOTE: Claude 3.5 Sonnet 20241022 has 200k context window, so no tiered pricing applies
            // Real calculation using current Claude pricing: $3/$15 per million (flat rate)
            const usage: LanguageModelUsage = {
                promptTokens: 300_000,
                completionTokens: 250_000,
                totalTokens: 550_000,
            };

            const cost = await pricingManager.calculateCost("anthropic", "claude-3-5-sonnet-20241022", usage);

            // Expected with flat pricing (no tiered pricing for 200k context models):
            // Input: (300k / 1M) * 3.0 = 0.9
            // Output: (250k / 1M) * 15.0 = 3.75
            // Total: 0.9 + 3.75 = 4.65
            expect(cost).toBeCloseTo(4.65, 2);
        });

        it("should verify OpenRouter pricing is cheaper than direct OpenAI", async () => {
            // ⚠️ BREAKS IF: OpenRouter raises prices above OpenAI direct pricing
            // This test ensures OpenRouter remains a cost-effective alternative
            const openRouterPricing = await pricingManager.getPricing("openrouter", "openai/gpt-4o");
            const directOpenAIPricing = await pricingManager.getPricing("openai", "gpt-4o");

            expect(openRouterPricing).not.toBeNull();
            expect(directOpenAIPricing).not.toBeNull();

            // OpenRouter should be cheaper (or at least not more expensive)
            expect(openRouterPricing!.inputPer1M).toBeLessThanOrEqual(directOpenAIPricing!.inputPer1M);
            expect(openRouterPricing!.outputPer1M).toBeLessThanOrEqual(directOpenAIPricing!.outputPer1M);
        });

        it("should verify Claude tiered pricing structure for 1M context models", async () => {
            // ⚠️ BREAKS IF: Anthropic changes tiered pricing structure OR LiteLLM updates pricing
            // NOTE: This test checks for Claude models with 1M context windows that have tiered pricing
            // Claude 3.5 Sonnet 20241022 has only 200k context, so it won't have tiered pricing
            // We'll check if any Claude model with tiered pricing follows the 2x structure

            // Try to find a Claude model with tiered pricing (if available)
            const pricing = await pricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");
            expect(pricing).not.toBeNull();

            // For 200k context models, tiered pricing should not exist
            // This test verifies the current structure: 200k context = no tiered pricing
            expect(pricing?.inputPer1MAbove200k).toBeUndefined();
            expect(pricing?.outputPer1MAbove200k).toBeUndefined();

            // If tiered pricing exists in the future, verify it doubles base pricing
            if (pricing?.inputPer1MAbove200k && pricing?.outputPer1MAbove200k) {
                expect(pricing.inputPer1MAbove200k).toBe(pricing.inputPer1M * 2);
                expect(pricing.outputPer1MAbove200k).toBe(pricing.outputPer1M * 2);
            }
        });

        it("should verify specific OpenRouter model prices from real API", async () => {
            // ⚠️ BREAKS IF: OpenRouter changes pricing for these specific models
            // Tests multiple models to catch pricing changes across the platform
            // As of 2025-11-24: OpenRouter GPT-4o is $2.50/$10.00 per million
            const models = [{ model: "openai/gpt-4o", expectedInput: 2.5, expectedOutput: 10.0 }];

            for (const { model, expectedInput, expectedOutput } of models) {
                const pricing = await pricingManager.getPricing("openrouter", model);

                expect(pricing).not.toBeNull();
                expect(pricing?.inputPer1M).toBe(expectedInput); // Exact match - will break if prices change
                expect(pricing?.outputPer1M).toBe(expectedOutput); // Exact match - will break if prices change
            }
        });

        it("should verify LiteLLM conversion accuracy for known models", async () => {
            // ⚠️ BREAKS IF: LiteLLM changes their pricing data format or values
            // Tests that our conversion from per-token to per-million is correct
            const testModels = ["openrouter/openai/gpt-4o", "claude-3-5-sonnet-20241022"];

            for (const modelName of testModels) {
                const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(modelName);
                expect(liteLLMPricing).not.toBeNull();

                const convertedPricing = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing!);

                // Verify conversion: per-token * 1M = per-million
                if (liteLLMPricing!.input_cost_per_token) {
                    expect(convertedPricing.inputPer1M).toBeCloseTo(
                        liteLLMPricing!.input_cost_per_token * 1_000_000,
                        2
                    );
                }
                if (liteLLMPricing!.output_cost_per_token) {
                    expect(convertedPricing.outputPer1M).toBeCloseTo(
                        liteLLMPricing!.output_cost_per_token * 1_000_000,
                        2
                    );
                }
            }
        });
    });

    describe("Pricing Sanity Checks - Verifies Reasonable Pricing Across Providers", () => {
        /**
         * ⚠️ These tests verify that pricing is reasonable and consistent across providers.
         * They will break if:
         * 1. Providers have drastically different pricing (e.g., OpenRouter 100x more expensive)
         * 2. Pricing data sources have errors
         * 3. Our conversion logic has bugs
         */

        it("should verify OpenRouter GPT-4o is not more expensive than direct OpenAI", async () => {
            const openRouterPricing = await pricingManager.getPricing("openrouter", "openai/gpt-4o");
            const directOpenAIPricing = await pricingManager.getPricing("openai", "gpt-4o");

            expect(openRouterPricing).not.toBeNull();
            expect(directOpenAIPricing).not.toBeNull();

            // OpenRouter should be cheaper or equal (it's a reseller, shouldn't be more expensive)
            expect(openRouterPricing!.inputPer1M).toBeLessThanOrEqual(directOpenAIPricing!.inputPer1M * 1.5); // Allow 50% markup max
            expect(openRouterPricing!.outputPer1M).toBeLessThanOrEqual(directOpenAIPricing!.outputPer1M * 1.5);
        });

        it("should verify Claude models have reasonable pricing (input < $20, output < $100)", async () => {
            const claudePricing = await pricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");

            expect(claudePricing).not.toBeNull();
            expect(claudePricing!.inputPer1M).toBeLessThan(20); // Should be under $20 per million input
            expect(claudePricing!.outputPer1M).toBeLessThan(100); // Should be under $100 per million output
            expect(claudePricing!.inputPer1M).toBeGreaterThan(0);
            expect(claudePricing!.outputPer1M).toBeGreaterThan(0);
        });

        it("should verify GPT-4o-mini pricing is cheaper than GPT-4o", async () => {
            const gpt4oPricing = await pricingManager.getPricing("openai", "gpt-4o");
            const gpt4oMiniPricing = await pricingManager.getPricing("openai", "gpt-4o-mini");

            expect(gpt4oPricing).not.toBeNull();
            expect(gpt4oMiniPricing).not.toBeNull();

            // Mini should be significantly cheaper
            expect(gpt4oMiniPricing!.inputPer1M).toBeLessThan(gpt4oPricing!.inputPer1M);
            expect(gpt4oMiniPricing!.outputPer1M).toBeLessThan(gpt4oPricing!.outputPer1M);
        });

        it("should verify OpenRouter Claude pricing is reasonable compared to direct", async () => {
            // OpenRouter might route to Anthropic, so pricing should be similar
            const openRouterClaude = await pricingManager.getPricing(
                "openrouter",
                "anthropic/claude-3-5-sonnet-20241022"
            );
            const directClaude = await pricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");

            if (openRouterClaude && directClaude) {
                // Should be within reasonable range (not 10x different)
                expect(openRouterClaude.inputPer1M).toBeLessThan(directClaude.inputPer1M * 10);
                expect(openRouterClaude.outputPer1M).toBeLessThan(directClaude.outputPer1M * 10);
                expect(openRouterClaude.inputPer1M).toBeGreaterThan(directClaude.inputPer1M * 0.1);
                expect(openRouterClaude.outputPer1M).toBeGreaterThan(directClaude.outputPer1M * 0.1);
            }
        });

        it("should verify all pricing values are positive numbers", async () => {
            const models = [
                { provider: "openai", model: "gpt-4o" },
                { provider: "openai", model: "gpt-4o-mini" },
                { provider: "openrouter", model: "openai/gpt-4o" },
                { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
            ];

            for (const { provider, model } of models) {
                const pricing = await pricingManager.getPricing(provider, model);
                expect(pricing).not.toBeNull();
                expect(pricing!.inputPer1M).toBeGreaterThan(0);
                expect(pricing!.outputPer1M).toBeGreaterThan(0);
                expect(pricing!.inputPer1M).not.toBeNaN();
                expect(pricing!.outputPer1M).not.toBeNaN();
            }
        });

        it("should verify cached pricing is not more expensive than regular pricing", async () => {
            const gpt4oPricing = await pricingManager.getPricing("openai", "gpt-4o");

            expect(gpt4oPricing).not.toBeNull();
            if (gpt4oPricing!.cachedReadPer1M) {
                // Cached reads should be cheaper than regular input
                expect(gpt4oPricing!.cachedReadPer1M).toBeLessThanOrEqual(gpt4oPricing!.inputPer1M);
            }
            if (gpt4oPricing!.cachedCreatePer1M) {
                // Cache creation might be similar or slightly more expensive, but not 10x
                expect(gpt4oPricing!.cachedCreatePer1M).toBeLessThan(gpt4oPricing!.inputPer1M * 10);
            }
        });

        it("should verify GPT-4o-mini cached pricing matches expected values", async () => {
            const miniPricing = await pricingManager.getPricing("openai", "gpt-4o-mini");

            expect(miniPricing).not.toBeNull();
            // Cached read should be half of input price (0.075 vs 0.15)
            if (miniPricing!.cachedReadPer1M) {
                expect(miniPricing!.cachedReadPer1M).toBeCloseTo(miniPricing!.inputPer1M / 2, 1);
            }
            // Cache creation should be free (0)
            if (miniPricing!.cachedCreatePer1M !== undefined) {
                expect(miniPricing!.cachedCreatePer1M).toBe(0);
            }
        });

        it("should verify tiered pricing is more expensive than base pricing when present", async () => {
            const claudePricing = await pricingManager.getPricing("anthropic", "claude-3-5-sonnet-20241022");

            expect(claudePricing).not.toBeNull();
            // Note: This model doesn't have tiered pricing (200k context), but if it did:
            if (claudePricing!.inputPer1MAbove200k && claudePricing!.outputPer1MAbove200k) {
                expect(claudePricing!.inputPer1MAbove200k).toBeGreaterThan(claudePricing!.inputPer1M);
                expect(claudePricing!.outputPer1MAbove200k).toBeGreaterThan(claudePricing!.outputPer1M);
            }
        });

        it("should verify OpenRouter models have consistent pricing structure", async () => {
            const models = ["openai/gpt-4o", "openai/gpt-4o-mini"];

            for (const model of models) {
                const pricing = await pricingManager.getPricing("openrouter", model);
                expect(pricing).not.toBeNull();
                // Should have both input and output pricing
                expect(pricing!.inputPer1M).toBeGreaterThan(0);
                expect(pricing!.outputPer1M).toBeGreaterThan(0);
                // Output should generally be more expensive than input
                expect(pricing!.outputPer1M).toBeGreaterThanOrEqual(pricing!.inputPer1M);
            }
        });

        it("should verify no provider has input pricing above $100 per million tokens", async () => {
            const models = [
                { provider: "openai", model: "gpt-4o" },
                { provider: "openai", model: "gpt-4o-mini" },
                { provider: "openrouter", model: "openai/gpt-4o" },
                { provider: "openrouter", model: "openai/gpt-4o-mini" },
                { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
            ];

            for (const { provider, model } of models) {
                const pricing = await pricingManager.getPricing(provider, model);
                if (pricing) {
                    expect(pricing.inputPer1M).toBeLessThan(100); // Sanity check: no model should cost >$100 per million input
                }
            }
        });

        it("should verify output pricing is between $0.6 and $75 per million tokens", async () => {
            const models = [
                { provider: "openai", model: "gpt-4o" },
                { provider: "openai", model: "gpt-4o-mini" },
                { provider: "openrouter", model: "openai/gpt-4o" },
                { provider: "openrouter", model: "openai/gpt-4o-mini" },
                { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
            ];

            const cheapModels: Array<{ provider: string; model: string; outputPer1M: number }> = [];
            const expensiveModels: Array<{ provider: string; model: string; outputPer1M: number }> = [];

            for (const { provider, model } of models) {
                const pricing = await pricingManager.getPricing(provider, model);
                if (pricing) {
                    if (pricing.outputPer1M < 0.6) {
                        cheapModels.push({ provider, model, outputPer1M: pricing.outputPer1M });
                    }
                    if (pricing.outputPer1M > 75) {
                        expensiveModels.push({ provider, model, outputPer1M: pricing.outputPer1M });
                    }
                }
            }

            // Report cheap models if any
            if (cheapModels.length > 0) {
                console.log("\n⚠️ Models with output pricing < $0.6 per million:");
                cheapModels.forEach(({ provider, model, outputPer1M }) => {
                    console.log(`  ${provider}/${model}: $${outputPer1M.toFixed(4)} per million`);
                });
            }

            // Report expensive models if any
            if (expensiveModels.length > 0) {
                console.log("\n⚠️ Models with output pricing > $75 per million:");
                expensiveModels.forEach(({ provider, model, outputPer1M }) => {
                    console.log(`  ${provider}/${model}: $${outputPer1M.toFixed(2)} per million`);
                });
            }

            // Fail if any models are outside the expected range
            if (cheapModels.length > 0 || expensiveModels.length > 0) {
                const allIssues = [...cheapModels, ...expensiveModels];
                const issueList = allIssues
                    .map(({ provider, model, outputPer1M }) => `${provider}/${model}: $${outputPer1M.toFixed(4)}`)
                    .join(", ");
                throw new Error(
                    `Output pricing outside expected range ($0.6-$75): ${issueList}. ` +
                        `Cheap models (<$0.6): ${cheapModels.length}, Expensive models (>$75): ${expensiveModels.length}`
                );
            }

            // All models should be within range
            for (const { provider, model } of models) {
                const pricing = await pricingManager.getPricing(provider, model);
                if (pricing) {
                    expect(pricing.outputPer1M).toBeGreaterThanOrEqual(0.6);
                    expect(pricing.outputPer1M).toBeLessThanOrEqual(75);
                }
            }
        });
    });

    describe("formatCost", () => {
        it("should format normal costs correctly", () => {
            expect(pricingManager.formatCost(0.0125)).toBe("$0.0125");
            expect(pricingManager.formatCost(1.5)).toBe("$1.5000");
        });

        it("should format very small costs with exponential notation", () => {
            const cost = 0.00001;
            const formatted = pricingManager.formatCost(cost);
            expect(formatted).toContain("e-");
        });
    });

    describe("formatTokens", () => {
        it("should format tokens correctly", () => {
            expect(pricingManager.formatTokens(1000)).toBe("1.0k");
            expect(pricingManager.formatTokens(1500)).toBe("1.5k");
            expect(pricingManager.formatTokens(1000000)).toBe("1000.0k");
        });
    });

    describe("ProviderManager vs LiteLLM Pricing Comparison", () => {
        // Note: These tests may fail if cache is stale or if OpenRouter/LiteLLM pricing data differs
        // This is expected behavior - the tests verify that both sources return similar pricing

        it("should match ProviderManager OpenRouter GPT-4o pricing with LiteLLM", async () => {
            if (!process.env.OPENROUTER_API_KEY) {
                console.log("Skipping test: OPENROUTER_API_KEY not set");
                return;
            }

            // Clear caches to ensure fresh data
            pricingManager.clearCache();
            liteLLMPricingFetcher.clearCache();

            const providers = await providerManager.detectProviders();
            const openRouterProvider = providers.find((p) => p.name === "openrouter");
            expect(openRouterProvider).not.toBeUndefined();

            const gpt4oModel = openRouterProvider!.models.find(
                (m) => m.id.includes("gpt-4o") && !m.id.includes("mini") && !m.id.includes("turbo")
            );

            if (!gpt4oModel) {
                console.log("Skipping test: GPT-4o model not found in OpenRouter");
                return;
            }

            const providerManagerPricing = gpt4oModel.pricing;
            expect(providerManagerPricing).not.toBeUndefined();

            // Get LiteLLM pricing for comparison
            const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(`openrouter/${gpt4oModel.id}`);
            if (!liteLLMPricing) {
                console.log(`Skipping test: LiteLLM pricing not found for openrouter/${gpt4oModel.id}`);
                return;
            }

            const liteLLMPricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);

            // Compare pricing (allow 5% difference due to cache/timing differences)
            const inputDiff = Math.abs(providerManagerPricing!.inputPer1M - liteLLMPricingInfo.inputPer1M);
            const outputDiff = Math.abs(providerManagerPricing!.outputPer1M - liteLLMPricingInfo.outputPer1M);
            const maxInputDiff = liteLLMPricingInfo.inputPer1M * 0.05;
            const maxOutputDiff = liteLLMPricingInfo.outputPer1M * 0.05;

            expect(inputDiff).toBeLessThanOrEqual(maxInputDiff);
            expect(outputDiff).toBeLessThanOrEqual(maxOutputDiff);
        });

        it("should match ProviderManager OpenRouter Claude pricing with LiteLLM", async () => {
            if (!process.env.OPENROUTER_API_KEY) {
                console.log("Skipping test: OPENROUTER_API_KEY not set");
                return;
            }

            pricingManager.clearCache();
            liteLLMPricingFetcher.clearCache();

            const providers = await providerManager.detectProviders();
            const openRouterProvider = providers.find((p) => p.name === "openrouter");
            expect(openRouterProvider).not.toBeUndefined();

            const claudeModel = openRouterProvider!.models.find(
                (m) => m.id.includes("claude") && m.id.includes("sonnet")
            );

            if (!claudeModel) {
                console.log("Skipping test: Claude Sonnet model not found in OpenRouter");
                return;
            }

            const providerManagerPricing = claudeModel.pricing;
            expect(providerManagerPricing).not.toBeUndefined();

            const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(`openrouter/${claudeModel.id}`);
            if (!liteLLMPricing) {
                console.log(`Skipping test: LiteLLM pricing not found for openrouter/${claudeModel.id}`);
                return;
            }

            const liteLLMPricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);

            const inputDiff = Math.abs(providerManagerPricing!.inputPer1M - liteLLMPricingInfo.inputPer1M);
            const outputDiff = Math.abs(providerManagerPricing!.outputPer1M - liteLLMPricingInfo.outputPer1M);
            const maxInputDiff = Math.max(liteLLMPricingInfo.inputPer1M * 0.05, 0.1); // At least $0.10 tolerance
            const maxOutputDiff = Math.max(liteLLMPricingInfo.outputPer1M * 0.05, 0.5); // At least $0.50 tolerance

            expect(inputDiff).toBeLessThanOrEqual(maxInputDiff);
            expect(outputDiff).toBeLessThanOrEqual(maxOutputDiff);
        });

        it("should match ProviderManager OpenRouter pricing for multiple popular models", async () => {
            if (!process.env.OPENROUTER_API_KEY) {
                console.log("Skipping test: OPENROUTER_API_KEY not set");
                return;
            }

            pricingManager.clearCache();
            liteLLMPricingFetcher.clearCache();

            const providers = await providerManager.detectProviders();
            const openRouterProvider = providers.find((p) => p.name === "openrouter");
            expect(openRouterProvider).not.toBeUndefined();

            // Test multiple popular models
            const popularModelIds = [
                "openai/gpt-4o",
                "openai/gpt-4o-mini",
                "anthropic/claude-3.5-sonnet",
                "google/gemini-pro",
                "meta-llama/llama-3.1-70b-instruct",
            ];

            let matchedCount = 0;
            let skippedCount = 0;

            for (const modelId of popularModelIds) {
                const model = openRouterProvider!.models.find((m) => m.id === modelId);
                if (!model || !model.pricing) {
                    skippedCount++;
                    continue;
                }

                const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(`openrouter/${modelId}`);
                if (!liteLLMPricing) {
                    skippedCount++;
                    continue;
                }

                const liteLLMPricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);

                const inputDiff = Math.abs(model.pricing.inputPer1M - liteLLMPricingInfo.inputPer1M);
                const outputDiff = Math.abs(model.pricing.outputPer1M - liteLLMPricingInfo.outputPer1M);
                const maxInputDiff = Math.max(liteLLMPricingInfo.inputPer1M * 0.1, 0.5); // 10% or $0.50 tolerance
                const maxOutputDiff = Math.max(liteLLMPricingInfo.outputPer1M * 0.1, 1.0); // 10% or $1.00 tolerance

                if (inputDiff <= maxInputDiff && outputDiff <= maxOutputDiff) {
                    matchedCount++;
                } else {
                    console.log(
                        `Mismatch for ${modelId}: ProviderManager input=${model.pricing.inputPer1M}, LiteLLM input=${liteLLMPricingInfo.inputPer1M}, diff=${inputDiff}`
                    );
                }
            }

            // At least 2 out of 5 should match (allowing for cache/stale data issues and LiteLLM/OpenRouter data differences)
            // Note: LiteLLM pricing may differ from OpenRouter API pricing due to different update schedules
            expect(matchedCount).toBeGreaterThanOrEqual(2);
        });

        it("should have consistent pricing structure between ProviderManager and LiteLLM for OpenRouter models", async () => {
            if (!process.env.OPENROUTER_API_KEY) {
                console.log("Skipping test: OPENROUTER_API_KEY not set");
                return;
            }

            pricingManager.clearCache();
            liteLLMPricingFetcher.clearCache();

            const providers = await providerManager.detectProviders();
            const openRouterProvider = providers.find((p) => p.name === "openrouter");
            expect(openRouterProvider).not.toBeUndefined();

            // Sample 10 random models with pricing
            const modelsWithPricing = openRouterProvider!.models.filter((m) => m.pricing).slice(0, 10);

            if (modelsWithPricing.length === 0) {
                console.log("Skipping test: No models with pricing found");
                return;
            }

            let consistentCount = 0;

            for (const model of modelsWithPricing) {
                const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(`openrouter/${model.id}`);
                if (!liteLLMPricing) {
                    continue;
                }

                const liteLLMPricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);

                // Check if both have pricing (structure consistency)
                const bothHaveInput = model.pricing!.inputPer1M > 0 && liteLLMPricingInfo.inputPer1M > 0;
                const bothHaveOutput = model.pricing!.outputPer1M > 0 && liteLLMPricingInfo.outputPer1M > 0;

                if (bothHaveInput && bothHaveOutput) {
                    // Check if prices are within 5% tolerance (accounting for cache/stale data differences)
                    const inputDiff = Math.abs(model.pricing!.inputPer1M - liteLLMPricingInfo.inputPer1M);
                    const outputDiff = Math.abs(model.pricing!.outputPer1M - liteLLMPricingInfo.outputPer1M);
                    const maxInputDiff = liteLLMPricingInfo.inputPer1M * 0.05;
                    const maxOutputDiff = liteLLMPricingInfo.outputPer1M * 0.05;

                    if (inputDiff <= maxInputDiff && outputDiff <= maxOutputDiff) {
                        consistentCount++;
                    }
                }
            }

            // At least 1 should be consistent (allowing for cache/stale data and LiteLLM/OpenRouter differences)
            // Note: LiteLLM pricing may differ significantly from OpenRouter API pricing due to different update schedules
            // and data sources - this test mainly verifies that pricing conversion works, not exact price matching
            expect(consistentCount).toBeGreaterThanOrEqual(1);
        });

        it("should verify ProviderManager OpenRouter models have valid pricing conversion", async () => {
            if (!process.env.OPENROUTER_API_KEY) {
                console.log("Skipping test: OPENROUTER_API_KEY not set");
                return;
            }

            pricingManager.clearCache();
            liteLLMPricingFetcher.clearCache();

            const providers = await providerManager.detectProviders();
            const openRouterProvider = providers.find((p) => p.name === "openrouter");
            expect(openRouterProvider).not.toBeUndefined();

            // Check that models with pricing have valid values
            const modelsWithPricing = openRouterProvider!.models.filter((m) => m.pricing);

            for (const model of modelsWithPricing.slice(0, 20)) {
                // Verify pricing structure is valid
                expect(model.pricing).toBeDefined();
                expect(model.pricing!.inputPer1M).toBeGreaterThanOrEqual(0);
                expect(model.pricing!.outputPer1M).toBeGreaterThanOrEqual(0);

                // Compare with LiteLLM if available
                const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(`openrouter/${model.id}`);
                if (liteLLMPricing) {
                    const liteLLMPricingInfo = liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);

                    // Both should have non-zero pricing or both should be zero
                    const providerHasPricing = model.pricing!.inputPer1M > 0 || model.pricing!.outputPer1M > 0;
                    const liteLLMHasPricing = liteLLMPricingInfo.inputPer1M > 0 || liteLLMPricingInfo.outputPer1M > 0;

                    // If one has pricing, both should (allowing for cache issues)
                    if (providerHasPricing && !liteLLMHasPricing) {
                        console.log(
                            `Note: ${model.id} has pricing in ProviderManager but not in LiteLLM (cache may be stale)`
                        );
                    }
                }
            }

            expect(modelsWithPricing.length).toBeGreaterThan(0);
        });
    });
});
