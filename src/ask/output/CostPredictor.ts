import { dynamicPricingManager } from "@ask/providers/DynamicPricing";

export interface CostPrediction {
    estimatedCost: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    confidence: "low" | "medium" | "high";
    reasoning: string;
}

export class CostPredictor {
    /**
     * Estimate cost for a text generation request
     * @param provider Provider name
     * @param model Model name
     * @param inputText Input text to estimate tokens for
     * @param estimatedOutputLength Estimated output length in characters (optional)
     * @returns Cost prediction
     */
    async predictCost(
        provider: string,
        model: string,
        inputText: string,
        estimatedOutputLength?: number,
    ): Promise<CostPrediction> {
        // Estimate input tokens (rough approximation: ~4 chars per token)
        const estimatedInputTokens = Math.ceil(inputText.length / 4);

        // Estimate output tokens (default to 500 tokens if not specified)
        const estimatedOutputTokens = estimatedOutputLength ? Math.ceil(estimatedOutputLength / 4) : 500;

        // Get pricing for the model
        const pricing = await dynamicPricingManager.getPricing(provider, model);

        if (!pricing) {
            return {
                estimatedCost: 0,
                estimatedInputTokens,
                estimatedOutputTokens,
                confidence: "low",
                reasoning: `Could not determine pricing for ${provider}/${model}. Cost estimation unavailable.`,
            };
        }

        // Calculate estimated cost (pricing is per 1M tokens)
        const inputCost = (estimatedInputTokens / 1_000_000) * pricing.inputPer1M;
        const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.outputPer1M;
        const estimatedCost = inputCost + outputCost;

        // Determine confidence based on whether we have pricing data
        let confidence: "low" | "medium" | "high" = "medium";
        let reasoning = `Estimated cost for ${estimatedInputTokens} input tokens and ${estimatedOutputTokens} output tokens`;

        if (estimatedOutputLength === undefined) {
            confidence = "low";
            reasoning += " (output length estimated, actual may vary significantly)";
        } else {
            confidence = "high";
            reasoning += " (based on provided output length estimate)";
        }

        return {
            estimatedCost,
            estimatedInputTokens,
            estimatedOutputTokens,
            confidence,
            reasoning,
        };
    }

    /**
     * Format cost prediction for display
     */
    formatPrediction(prediction: CostPrediction): string {
        const costStr = dynamicPricingManager.formatCost(prediction.estimatedCost);
        const inputTokensStr = dynamicPricingManager.formatTokens(prediction.estimatedInputTokens);
        const outputTokensStr = dynamicPricingManager.formatTokens(prediction.estimatedOutputTokens);

        let confidenceEmoji = "⚠️";
        if (prediction.confidence === "high") {
            confidenceEmoji = "✅";
        } else if (prediction.confidence === "medium") {
            confidenceEmoji = "⚡";
        }

        return `${confidenceEmoji} Estimated cost: ${costStr} (${inputTokensStr} input + ${outputTokensStr} output tokens)\n   ${prediction.reasoning}`;
    }
}

// Singleton instance
export const costPredictor = new CostPredictor();
