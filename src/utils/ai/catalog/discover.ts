import { fetchOpenRouterCatalog, toCatalogEntry } from "./openrouter";
import { byProvider } from "./static";
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
 * The fetching, caching and record-to-entry mapping all live in
 * `catalog/openrouter.ts` — one catalog, shared with ai-proxy. This module used
 * to keep its own hour-long in-memory cache and its own `toEntry`, which meant
 * the CLI's model list and the proxy's could disagree about the same model.
 */

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

    const catalog = await fetchOpenRouterCatalog();
    const live = (catalog?.models ?? []).map(toCatalogEntry);
    const known = new Set(staticEntries.map((entry) => entry.id));

    return [...staticEntries, ...live.filter((entry) => !known.has(entry.id))];
}
