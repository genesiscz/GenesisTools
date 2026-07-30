/**
 * Compatibility shim. The registry moved to `@genesiscz/utils/ai/catalog`,
 * where it stopped being Anthropic-only.
 *
 * Consumers keep importing this path until Phase 8 rewires them; nothing new
 * should. The one behavioural difference is that `MODEL_REGISTRY` now contains
 * every provider, so a caller that assumed "everything here is Anthropic" must
 * filter — which is why `byProvider("anthropic")` was already the idiom at all
 * four call sites.
 *
 * @deprecated Import from `@genesiscz/utils/ai/catalog` instead.
 */

export {
    aliasMapFor,
    byCapability,
    byId,
    byProvider,
    inputModalitiesFor,
    isDatedModelId,
    STATIC_CATALOG as MODEL_REGISTRY,
    staticPricingFor as pricingFor,
    stripModelVariantSuffix,
} from "../catalog/static";
export type { CatalogEntry as CanonicalModel, ModelFamily, ModelPricing } from "../catalog/types";
