import { logger } from "@app/logger";
import type { Storage } from "@app/utils/storage/storage";
import { DEFAULT_PRICING } from "./pricing";
import type { PricingTable } from "./types";

interface AiSpendConfig {
    pricing?: PricingTable;
}

export async function loadPricing(storage: Storage): Promise<PricingTable> {
    const config = await storage.getConfig<AiSpendConfig>();
    if (!config?.pricing) {
        return DEFAULT_PRICING;
    }

    logger.debug({ models: Object.keys(config.pricing) }, "ai-spend: merging user pricing overrides");
    return { ...DEFAULT_PRICING, ...config.pricing };
}
