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
    const merged: PricingTable = { ...DEFAULT_PRICING };
    for (const [model, override] of Object.entries(config.pricing)) {
        const base = merged[model];
        merged[model] = {
            input: override.input ?? base?.input ?? 0,
            output: override.output ?? base?.output ?? 0,
            cacheWrite: override.cacheWrite ?? base?.cacheWrite ?? 0,
            cacheRead: override.cacheRead ?? base?.cacheRead ?? 0,
        };
    }

    return merged;
}
