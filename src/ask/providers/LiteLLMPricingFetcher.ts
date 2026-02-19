import logger from "@app/logger";
import type { PricingInfo } from "@ask/types/provider";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { z } from "zod";

export const LITELLM_PRICING_URL =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Default token threshold for tiered pricing in 1M context window models.
 * LiteLLM's pricing schema hard-codes this threshold in field names
 * (e.g., `input_cost_per_token_above_200k_tokens`).
 */
const DEFAULT_TIERED_THRESHOLD = 200_000;

/**
 * LiteLLM Model Pricing Schema
 *
 * ⚠️ TIERED PRICING NOTE:
 * Different models use different token thresholds for tiered pricing:
 * - Claude/Anthropic: 200k tokens (implemented in calculateTieredCost)
 * - Gemini: 128k tokens (schema fields only, NOT implemented in calculations)
 * - GPT/OpenAI: No tiered pricing (flat rate)
 *
 * When adding support for new models:
 * 1. Check if model has tiered pricing in LiteLLM data
 * 2. Verify the threshold value
 * 3. Update calculateTieredCost logic if threshold differs from 200k
 */
export const liteLLMModelPricingSchema = z.object({
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
    max_tokens: z.number().optional(),
    max_input_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
    // Claude/Anthropic: 1M context window pricing (200k threshold)
    input_cost_per_token_above_200k_tokens: z.number().optional(),
    output_cost_per_token_above_200k_tokens: z.number().optional(),
    cache_creation_input_token_cost_above_200k_tokens: z.number().optional(),
    cache_read_input_token_cost_above_200k_tokens: z.number().optional(),
    // Gemini: Tiered pricing (128k threshold) - NOT implemented in calculations
    input_cost_per_token_above_128k_tokens: z.number().optional(),
    output_cost_per_token_above_128k_tokens: z.number().optional(),
});

export type LiteLLMModelPricing = z.infer<typeof liteLLMModelPricingSchema>;

export type PricingLogger = {
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
};

export type LiteLLMPricingFetcherOptions = {
    logger?: PricingLogger;
    offline?: boolean;
    offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
    url?: string;
    providerPrefixes?: string[];
};

const DEFAULT_PROVIDER_PREFIXES = [
    "anthropic/",
    "claude-3-5-",
    "claude-3-",
    "claude-",
    "openai/",
    "azure/",
    "openrouter/openai/",
];

function createLogger(logger?: PricingLogger): PricingLogger {
    if (logger != null) {
        return logger;
    }
    return {
        debug: () => {},
        error: () => {},
        info: () => {},
        warn: () => {},
    };
}

export class LiteLLMPricingFetcher {
    private cachedPricing: Map<string, LiteLLMModelPricing> | null = null;
    private loadingPromise: Promise<Map<string, LiteLLMModelPricing>> | null = null;
    private readonly logger: PricingLogger;
    private readonly offline: boolean;
    private readonly offlineLoader?: () => Promise<Record<string, LiteLLMModelPricing>>;
    private readonly url: string;
    private readonly providerPrefixes: string[];

    constructor(options: LiteLLMPricingFetcherOptions = {}) {
        this.logger = createLogger(options.logger);
        this.offline = Boolean(options.offline);
        this.offlineLoader = options.offlineLoader;
        this.url = options.url ?? LITELLM_PRICING_URL;
        this.providerPrefixes = options.providerPrefixes ?? DEFAULT_PROVIDER_PREFIXES;
    }

    private logDebug(msg: unknown, ...args: unknown[]): void {
        if (typeof msg === "object" && msg !== null) {
            this.logger.debug(msg as any, ...(args as any));
        } else {
            this.logger.debug({ msg }, ...(args as any));
        }
    }

    private logError(msg: unknown, ...args: unknown[]): void {
        if (typeof msg === "object" && msg !== null) {
            this.logger.error(msg as any, ...(args as any));
        } else {
            this.logger.error({ msg }, ...(args as any));
        }
    }

    private logInfo(msg: unknown, ...args: unknown[]): void {
        if (typeof msg === "object" && msg !== null) {
            this.logger.info(msg as any, ...(args as any));
        } else {
            this.logger.info({ msg }, ...(args as any));
        }
    }

    private logWarn(msg: unknown, ...args: unknown[]): void {
        if (typeof msg === "object" && msg !== null) {
            this.logger.warn(msg as any, ...(args as any));
        } else {
            this.logger.warn({ msg }, ...(args as any));
        }
    }

    clearCache(): void {
        this.cachedPricing = null;
        this.loadingPromise = null;
    }

    private async loadOfflinePricing(): Promise<Map<string, LiteLLMModelPricing>> {
        if (this.offlineLoader == null) {
            throw new Error("Offline loader was not provided");
        }
        const pricing = new Map(Object.entries(await this.offlineLoader()));
        this.cachedPricing = pricing;
        return pricing;
    }

    private async handleFallbackToCachedPricing(originalError: unknown): Promise<Map<string, LiteLLMModelPricing>> {
        this.logWarn("Failed to fetch model pricing from LiteLLM, falling back to cached pricing data");
        this.logDebug({ error: originalError }, "Fetch error details");
        try {
            const pricing = await this.loadOfflinePricing();
            this.logInfo(`Using cached pricing data for ${pricing.size} models`);
            return pricing;
        } catch (error) {
            this.logError({ error }, "Failed to load cached pricing data as fallback");
            this.logError({ originalError }, "Original fetch error");
            throw error;
        }
    }

    private async ensurePricingLoaded(): Promise<Map<string, LiteLLMModelPricing>> {
        // Return cached pricing if available
        if (this.cachedPricing != null) {
            return this.cachedPricing;
        }

        // If a fetch is already in progress, wait for it instead of starting a new one
        if (this.loadingPromise != null) {
            return await this.loadingPromise;
        }

        // Start a new fetch and store the promise so concurrent calls can wait for it
        this.loadingPromise = this.loadPricingData();
        try {
            const result = await this.loadingPromise;
            return result;
        } finally {
            // Clear the loading promise after completion (success or failure)
            this.loadingPromise = null;
        }
    }

    private async loadPricingData(): Promise<Map<string, LiteLLMModelPricing>> {
        if (this.offline) {
            return await this.loadOfflinePricing();
        }

        this.logInfo("Fetching latest model pricing from LiteLLM...");
        try {
            const response = await fetch(this.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch pricing data: ${response.statusText}`);
            }

            const data = (await response.json()) as Record<string, unknown>;
            const pricing = new Map<string, LiteLLMModelPricing>();

            for (const [modelName, modelData] of Object.entries(data)) {
                if (typeof modelData !== "object" || modelData == null) {
                    continue;
                }
                const parsed = liteLLMModelPricingSchema.safeParse(modelData);
                if (!parsed.success) {
                    continue;
                }
                pricing.set(modelName, parsed.data);
            }

            this.cachedPricing = pricing;
            return pricing;
        } catch (error) {
            return await this.handleFallbackToCachedPricing(error);
        }
    }

    async fetchModelPricing(): Promise<Map<string, LiteLLMModelPricing>> {
        return await this.ensurePricingLoaded();
    }

    private createMatchingCandidates(modelName: string): string[] {
        const candidates = new Set<string>();
        candidates.add(modelName);
        for (const prefix of this.providerPrefixes) {
            candidates.add(`${prefix}${modelName}`);
        }
        return Array.from(candidates);
    }

    async getModelPricing(modelName: string): Promise<LiteLLMModelPricing | null> {
        const pricing = await this.ensurePricingLoaded();

        // Try exact match first
        for (const candidate of this.createMatchingCandidates(modelName)) {
            const direct = pricing.get(candidate);
            if (direct != null) {
                return direct;
            }
        }

        // Try fuzzy matching (case-insensitive substring)
        const lower = modelName.toLowerCase();
        for (const [key, value] of pricing) {
            const comparison = key.toLowerCase();
            if (comparison.includes(lower) || lower.includes(comparison)) {
                return value;
            }
        }

        return null;
    }

    async getModelContextLimit(modelName: string): Promise<number | null> {
        const pricing = await this.getModelPricing(modelName);
        return pricing?.max_input_tokens ?? null;
    }

    /**
     * Calculate the total cost for token usage based on model pricing
     *
     * Supports tiered pricing for 1M context window models where tokens
     * above a threshold (default 200k) are charged at a different rate.
     * Handles all token types: input, output, cache creation, and cache read.
     *
     * @param tokens - Token counts for different types
     * @param tokens.input_tokens - Number of input tokens
     * @param tokens.output_tokens - Number of output tokens
     * @param tokens.cache_creation_input_tokens - Number of cache creation input tokens
     * @param tokens.cache_read_input_tokens - Number of cache read input tokens
     * @param pricing - Model pricing information from LiteLLM
     * @returns Total cost in USD
     */
    calculateCostFromPricing(
        tokens: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        },
        pricing: LiteLLMModelPricing
    ): number {
        /**
         * Calculate cost with tiered pricing for 1M context window models
         *
         * @param totalTokens - Total number of tokens to calculate cost for
         * @param basePrice - Price per token for tokens up to the threshold
         * @param tieredPrice - Price per token for tokens above the threshold
         * @param threshold - Token threshold for tiered pricing (default 200k)
         * @returns Total cost applying tiered pricing when applicable
         *
         * @example
         * // 300k tokens with base price $3/M and tiered price $6/M
         * calculateTieredCost(300_000, 3e-6, 6e-6)
         * // Returns: (200_000 * 3e-6) + (100_000 * 6e-6) = $1.2
         */
        const calculateTieredCost = (
            totalTokens: number | undefined,
            basePrice: number | undefined,
            tieredPrice: number | undefined,
            threshold: number = DEFAULT_TIERED_THRESHOLD
        ): number => {
            if (totalTokens == null || totalTokens <= 0) {
                return 0;
            }
            if (totalTokens > threshold && tieredPrice != null) {
                const tokensBelowThreshold = Math.min(totalTokens, threshold);
                const tokensAboveThreshold = Math.max(0, totalTokens - threshold);
                let tieredCost = tokensAboveThreshold * tieredPrice;
                if (basePrice != null) {
                    tieredCost += tokensBelowThreshold * basePrice;
                }
                return tieredCost;
            }
            if (basePrice != null) {
                return totalTokens * basePrice;
            }
            return 0;
        };

        const inputCost = calculateTieredCost(
            tokens.input_tokens,
            pricing.input_cost_per_token,
            pricing.input_cost_per_token_above_200k_tokens
        );
        const outputCost = calculateTieredCost(
            tokens.output_tokens,
            pricing.output_cost_per_token,
            pricing.output_cost_per_token_above_200k_tokens
        );
        const cacheCreationCost = calculateTieredCost(
            tokens.cache_creation_input_tokens,
            pricing.cache_creation_input_token_cost,
            pricing.cache_creation_input_token_cost_above_200k_tokens
        );
        const cacheReadCost = calculateTieredCost(
            tokens.cache_read_input_tokens,
            pricing.cache_read_input_token_cost,
            pricing.cache_read_input_token_cost_above_200k_tokens
        );

        return inputCost + outputCost + cacheCreationCost + cacheReadCost;
    }

    /**
     * Convert LiteLLM pricing (per token) to PricingInfo (per 1M tokens)
     */
    convertToPricingInfo(pricing: LiteLLMModelPricing): PricingInfo {
        // LiteLLM pricing is per token, convert to per 1M tokens (multiply by 1,000,000)
        const inputPer1M = pricing.input_cost_per_token ? pricing.input_cost_per_token * 1_000_000 : 0;
        const outputPer1M = pricing.output_cost_per_token ? pricing.output_cost_per_token * 1_000_000 : 0;
        const cachedReadPer1M = pricing.cache_read_input_token_cost
            ? pricing.cache_read_input_token_cost * 1_000_000
            : undefined;
        const cachedCreatePer1M = pricing.cache_creation_input_token_cost
            ? pricing.cache_creation_input_token_cost * 1_000_000
            : undefined;
        const inputPer1MAbove200k = pricing.input_cost_per_token_above_200k_tokens
            ? pricing.input_cost_per_token_above_200k_tokens * 1_000_000
            : undefined;
        const outputPer1MAbove200k = pricing.output_cost_per_token_above_200k_tokens
            ? pricing.output_cost_per_token_above_200k_tokens * 1_000_000
            : undefined;
        const cachedReadPer1MAbove200k = pricing.cache_read_input_token_cost_above_200k_tokens
            ? pricing.cache_read_input_token_cost_above_200k_tokens * 1_000_000
            : undefined;
        const cachedCreatePer1MAbove200k = pricing.cache_creation_input_token_cost_above_200k_tokens
            ? pricing.cache_creation_input_token_cost_above_200k_tokens * 1_000_000
            : undefined;

        return {
            inputPer1M,
            outputPer1M,
            cachedReadPer1M,
            cachedCreatePer1M,
            inputPer1MAbove200k,
            outputPer1MAbove200k,
            cachedReadPer1MAbove200k,
            cachedCreatePer1MAbove200k,
        };
    }

    async calculateCostFromTokens(
        tokens: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
        },
        modelName?: string
    ): Promise<number> {
        if (modelName == null || modelName === "") {
            return 0;
        }

        const pricing = await this.getModelPricing(modelName);
        if (pricing == null) {
            throw new Error(`Model pricing not found for ${modelName}`);
        }

        return this.calculateCostFromPricing(tokens, pricing);
    }
}

// Singleton instance — uses clack for user-facing info, pino for debug/warn/error
export const liteLLMPricingFetcher = new LiteLLMPricingFetcher({
    logger: {
        debug: (msg: unknown, ...args: unknown[]) => {
            if (typeof msg === "object" && msg !== null) {
                logger.debug(msg as object, args[0] as string | undefined);
            } else {
                logger.debug({ msg: String(msg) }, args[0] as string | undefined);
            }
        },
        error: (msg: unknown, ...args: unknown[]) => {
            if (typeof msg === "object" && msg !== null) {
                logger.error(msg as object, args[0] as string | undefined);
            } else {
                logger.error({ msg: String(msg) }, args[0] as string | undefined);
            }
        },
        info: (msg: unknown) => {
            // logInfo wraps strings as { msg }, so unwrap them
            const text =
                typeof msg === "object" && msg !== null && "msg" in (msg as Record<string, unknown>)
                    ? String((msg as Record<string, unknown>).msg)
                    : String(msg);
            p.log.step(pc.dim(text));
        },
        warn: (msg: unknown, ...args: unknown[]) => {
            if (typeof msg === "object" && msg !== null) {
                logger.warn(msg as object, args[0] as string | undefined);
            } else {
                logger.warn({ msg: String(msg) }, args[0] as string | undefined);
            }
        },
    },
});
