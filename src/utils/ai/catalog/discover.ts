import { logger } from "@genesiscz/utils/logger";
import { convertOpenRouterPricing, type OpenRouterPricingShape } from "./pricing";
import { byProvider, formatModelDisplayName } from "./static";
import type { CatalogEntry } from "./types";

/**
 * Models a provider serves that the curated catalog does not enumerate.
 *
 * The static list is hand-verified and deliberately short. That is right for
 * vendors with a dozen models and wrong for an aggregator: OpenRouter routes
 * several hundred, they change weekly, and its whole value is that breadth. So
 * the catalog answers for OpenRouter by asking OpenRouter, and the result is
 * marked `source: "openrouter"` rather than pretending to be curated.
 *
 * This replaces the per-provider `/v1/models` calls that used to live inside
 * ask's `ProviderManager`, where nothing else could reach them.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;

interface OpenRouterModel {
    id: string;
    name?: string;
    context_length?: number;
    description?: string;
    pricing?: OpenRouterPricingShape;
}

interface CacheEntry {
    entries: CatalogEntry[];
    at: number;
}

const cache = new Map<string, CacheEntry>();

function toEntry(model: OpenRouterModel): CatalogEntry {
    // "reasoning" comes from OpenRouter's own description of the model, not from
    // pattern-matching its id: the aggregator is the one that knows.
    const reasoning = `${model.id} ${model.description ?? ""}`.toLowerCase().includes("reasoning");

    return {
        id: model.id,
        provider: "openrouter",
        displayName: model.name || formatModelDisplayName(model.id),
        contextWindow: model.context_length ?? 4096,
        capabilities: new Set(["chat"]),
        ...(reasoning ? { thinking: "reasoning" as const } : {}),
        ...(model.pricing ? { pricing: convertOpenRouterPricing(model.pricing) } : {}),
        source: "openrouter",
    };
}

/**
 * The OpenRouter catalog. Unauthenticated on purpose: the models endpoint is
 * public, and requiring a key would mean a user could not even SEE what the
 * account they are about to configure would offer.
 */
async function fetchOpenRouterModels(): Promise<CatalogEntry[]> {
    try {
        const response = await fetch(OPENROUTER_MODELS_URL, { headers: { "X-Title": "GenesisTools" } });

        if (!response.ok) {
            throw new Error(`OpenRouter API error: ${response.status}`);
        }

        const data = (await response.json()) as { data: OpenRouterModel[] };
        const entries = data.data.map(toEntry);
        logger.debug({ count: entries.length }, "discovered OpenRouter models");

        return entries;
    } catch (err) {
        logger.warn({ err }, "OpenRouter model discovery failed — falling back to the static catalog");
        return [];
    }
}

/**
 * Every model the catalog can name for a provider: the curated entries first,
 * then anything a live listing adds. Curated entries win on id collision — they
 * carry cache-tier pricing and context flags a feed does not.
 */
export async function discoverModels(provider: string): Promise<CatalogEntry[]> {
    const staticEntries = byProvider(provider);

    if (provider !== "openrouter") {
        return staticEntries;
    }

    const hit = cache.get(provider);
    const live = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.entries : await fetchOpenRouterModels();

    if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) {
        cache.set(provider, { entries: live, at: Date.now() });
    }

    const known = new Set(staticEntries.map((entry) => entry.id));
    return [...staticEntries, ...live.filter((entry) => !known.has(entry.id))];
}

export function clearDiscoveryCache(): void {
    cache.clear();
}
