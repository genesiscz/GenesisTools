/**
 * Compatibility shim. The fetcher moved to `@genesiscz/utils/ai/catalog/litellm`
 * so the catalog owns price discovery instead of the ask tool.
 *
 * @deprecated Import from `@genesiscz/utils/ai/catalog/litellm` instead.
 */

export type {
    LiteLLMModelPricing,
    LiteLLMPricingFetcherOptions,
    PricingLogger,
} from "@genesiscz/utils/ai/catalog/litellm";
export {
    LITELLM_PRICING_URL,
    LiteLLMPricingFetcher,
    liteLLMModelPricingSchema,
    liteLLMPricingFetcher,
} from "@genesiscz/utils/ai/catalog/litellm";
