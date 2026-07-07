/**
 * Cached work item enrichment service.
 *
 * Provides cache-first resolution of work item IDs to titles/states/types,
 * and cached work item type definitions (colors, icons, states).
 *
 * Used by Clarity UI and CLI commands that need lightweight work item metadata
 * without fetching full details every time.
 */

import { loadWorkItemCache, saveWorkItemCache, storage, WORKITEM_FRESHNESS_MINUTES } from "@app/azure-devops/cache";
import { AzAuthError, isAuthError } from "@app/azure-devops/cli.utils";

async function createApi(config: import("@app/azure-devops/types").AzureConfig) {
    const { Api } = await import("@app/azure-devops/api");
    return new Api(config);
}

import { parseRelations } from "@app/azure-devops/relations";
import type { AzureConfig, WorkItemCache, WorkItemFull, WorkItemTypeDefinition } from "@app/azure-devops/types";
import { WORKITEM_CACHE_VERSION } from "@app/azure-devops/types";
import { logger } from "@app/logger";

// ============= Types =============

/** Minimal reference to a work item's first hierarchy parent */
export interface WorkItemParentRef {
    id: number;
    title: string;
    type?: string;
}

/** Lightweight work item info returned by the enrichment service */
export interface EnrichedWorkItem {
    id: number;
    title: string;
    state: string;
    type?: string;
    assignee?: string;
    changed: string;
    /** First hierarchy parent ID (`null` = none). Only reliable when fetched with parent support. */
    parentId?: number | null;
    /** Resolved parent info. Populated only when `includeParents: true`. */
    parent?: WorkItemParentRef;
}

export interface EnrichWorkItemsOptions {
    /** Skip cache and always fetch from API. Default: false */
    force?: boolean;
    /** Include work item type (System.WorkItemType). Requires fetching rawFields. Default: true */
    includeType?: boolean;
    /**
     * Resolve each item's first hierarchy parent (id + title + type) via the same
     * cache-first strategy. Costs one extra batch fetch for uncached parents —
     * leave off unless the caller actually renders parent info. Default: false
     */
    includeParents?: boolean;
}

/** Cached type definitions with color info */
export interface WorkItemTypeColor {
    name: string;
    color: string;
    icon: { id: string; url: string };
}

interface TypeDefinitionsCache {
    definitions: WorkItemTypeDefinition[];
    fetchedAt: string;
}

// ============= Constants =============

const TYPE_DEFINITIONS_CACHE_KEY = "type-definitions";
const TYPE_DEFINITIONS_TTL = "7 days";

// ============= Work Item Enrichment =============

/**
 * Resolve work item IDs to lightweight metadata using cache-first strategy.
 *
 * 1. Check local cache for each ID
 * 2. IDs not in cache (or stale) are batch-fetched from API
 * 3. Fetched items are saved to cache for next time
 *
 * @returns Map of ID → EnrichedWorkItem (missing IDs are omitted)
 */
export async function enrichWorkItems(
    config: AzureConfig,
    ids: number[],
    options: EnrichWorkItemsOptions = {}
): Promise<Map<number, EnrichedWorkItem>> {
    const { force = false, includeType = true, includeParents = false } = options;
    const result = new Map<number, EnrichedWorkItem>();

    if (ids.length === 0) {
        return result;
    }

    const uniqueIds = [...new Set(ids)];
    const idsToFetch: number[] = [];

    // Phase 1: Check cache for each ID
    if (!force) {
        for (const id of uniqueIds) {
            const cached = await loadWorkItemCache(id);

            // Entries written before parent support lack `parentId` entirely —
            // refetch those when the caller needs parents.
            const parentUsable = !includeParents || cached?.parentId !== undefined;

            if (cached && isCacheFresh(cached) && parentUsable) {
                result.set(id, cacheToEnriched(cached, includeType));
                logger.debug(`[enrichment] Cache hit for #${id}`);
            } else {
                idsToFetch.push(id);
            }
        }
    } else {
        idsToFetch.push(...uniqueIds);
    }

    logger.debug(`[enrichment] ${result.size} cache hits, ${idsToFetch.length} to fetch`);

    // Phase 2: Batch fetch missing items from API
    if (idsToFetch.length > 0) {
        const api = await createApi(config);
        let fetched: Map<number, import("@app/azure-devops/types").WorkItemFull>;

        try {
            fetched = await api.getWorkItems(idsToFetch, {
                comments: false,
                updates: false,
            });
        } catch (err) {
            // Auth/network failures are not per-item issues — abort enrichment
            // entirely and propagate, so callers can surface a real error.
            if (err instanceof AzAuthError || isAuthError(err instanceof Error ? err.message : String(err))) {
                throw err;
            }

            // Genuine batch failure (one bad ID can fail the whole batch) → fall back
            // to per-item fetches, treating only true 404s as skippable.
            const batchMsg = err instanceof Error ? err.message : String(err);
            logger.warn(`[enrichment] Batch fetch failed (${batchMsg}), falling back to per-item fetches`);
            fetched = new Map();

            for (const id of idsToFetch) {
                try {
                    const single = await api.getWorkItems([id], { comments: false, updates: false });
                    for (const [sId, sItem] of single) {
                        fetched.set(sId, sItem);
                    }
                } catch (singleErr) {
                    if (
                        singleErr instanceof AzAuthError ||
                        isAuthError(singleErr instanceof Error ? singleErr.message : String(singleErr))
                    ) {
                        throw singleErr;
                    }
                    const msg = singleErr instanceof Error ? singleErr.message : String(singleErr);
                    if (msg.includes("404") || msg.includes("does not exist")) {
                        logger.warn(`[enrichment] Skipping work item #${id} (404 not found)`);
                    } else {
                        logger.warn(`[enrichment] Failed to fetch #${id}: ${msg}`);
                    }
                }
            }
        }

        for (const [id, item] of fetched) {
            const itemType = (item.rawFields?.["System.WorkItemType"] as string | undefined) ?? undefined;
            const parentId = extractParentId(item);

            const cacheEntry: WorkItemCache = {
                version: WORKITEM_CACHE_VERSION,
                cache: { fieldsFetchedAt: new Date().toISOString() },
                id: item.id,
                rev: item.rev,
                changed: item.changed,
                title: item.title,
                state: item.state,
                type: itemType,
                assignee: item.assignee,
                parentId,
            };

            await saveWorkItemCache(id, cacheEntry);

            const enriched: EnrichedWorkItem = {
                id: item.id,
                title: item.title,
                state: item.state,
                type: includeType ? itemType : undefined,
                assignee: item.assignee,
                changed: item.changed,
                parentId,
            };

            result.set(id, enriched);
        }

        logger.debug(`[enrichment] Fetched ${fetched.size} items from API`);
    }

    // Phase 3 (opt-in): resolve parents through the same cache-first pipeline
    if (includeParents) {
        await attachParents(config, result, { force, includeType });
    }

    return result;
}

/** Extract the first hierarchy parent ID from a fetched work item (`null` = no parent). */
function extractParentId(item: WorkItemFull): number | null {
    const rawParent = item.rawFields?.["System.Parent"];

    if (typeof rawParent === "number") {
        return rawParent;
    }

    if (item.relations) {
        return parseRelations(item.relations).parent ?? null;
    }

    return null;
}

/** Resolve `parentId` references into `parent` refs using enrichWorkItems (shared cache). */
async function attachParents(
    config: AzureConfig,
    items: Map<number, EnrichedWorkItem>,
    options: { force: boolean; includeType: boolean }
): Promise<void> {
    const parentIds = [
        ...new Set(
            [...items.values()]
                .map((item) => item.parentId)
                .filter((pid): pid is number => typeof pid === "number" && pid > 0)
        ),
    ];

    if (parentIds.length === 0) {
        return;
    }

    const parents = await enrichWorkItems(config, parentIds, options);

    for (const item of items.values()) {
        if (typeof item.parentId !== "number") {
            continue;
        }

        const parent = parents.get(item.parentId);
        if (parent) {
            item.parent = { id: parent.id, title: parent.title, type: parent.type };
        }
    }

    logger.debug(`[enrichment] Attached ${parents.size} parents for ${items.size} items`);
}

// ============= Type Definitions =============

/**
 * Get work item type definitions with colors, cached with 7-day TTL.
 *
 * Returns a map of type name → color/icon info for rendering badges.
 */
export async function getWorkItemTypeColors(
    config: AzureConfig,
    options?: { force?: boolean }
): Promise<Map<string, WorkItemTypeColor>> {
    await storage.ensureDirs();

    // Check cache first
    if (!options?.force) {
        const cached = await storage.getCacheFile<TypeDefinitionsCache>(
            `${TYPE_DEFINITIONS_CACHE_KEY}-${config.projectId}.json`,
            TYPE_DEFINITIONS_TTL
        );

        if (cached) {
            logger.debug(`[enrichment] Type definitions cache hit (${cached.definitions.length} types)`);
            return definitionsToColorMap(cached.definitions);
        }
    }

    // Fetch from API
    const api = await createApi(config);
    const definitions = await api.getWorkItemTypeDefinitions();

    // Save to cache
    const cacheData: TypeDefinitionsCache = {
        definitions,
        fetchedAt: new Date().toISOString(),
    };

    await storage.putCacheFile(
        `${TYPE_DEFINITIONS_CACHE_KEY}-${config.projectId}.json`,
        cacheData,
        TYPE_DEFINITIONS_TTL
    );

    logger.debug(`[enrichment] Cached ${definitions.length} type definitions`);

    return definitionsToColorMap(definitions);
}

/**
 * Get raw type definitions (full objects), cached with 7-day TTL.
 * Useful when you need states, transitions, or field info beyond just colors.
 */
export async function getWorkItemTypeDefinitions(
    config: AzureConfig,
    options?: { force?: boolean }
): Promise<WorkItemTypeDefinition[]> {
    await storage.ensureDirs();

    if (!options?.force) {
        const cached = await storage.getCacheFile<TypeDefinitionsCache>(
            `${TYPE_DEFINITIONS_CACHE_KEY}-${config.projectId}.json`,
            TYPE_DEFINITIONS_TTL
        );

        if (cached) {
            return cached.definitions;
        }
    }

    const api = await createApi(config);
    const definitions = await api.getWorkItemTypeDefinitions();

    await storage.putCacheFile(
        `${TYPE_DEFINITIONS_CACHE_KEY}-${config.projectId}.json`,
        { definitions, fetchedAt: new Date().toISOString() } satisfies TypeDefinitionsCache,
        TYPE_DEFINITIONS_TTL
    );

    return definitions;
}

// ============= Helpers =============

function isCacheFresh(cache: WorkItemCache): boolean {
    const fetchedAt = cache.cache?.fieldsFetchedAt;

    if (!fetchedAt) {
        return false;
    }

    const ageMs = Date.now() - new Date(fetchedAt).getTime();
    return ageMs < WORKITEM_FRESHNESS_MINUTES * 60 * 1000;
}

function cacheToEnriched(cache: WorkItemCache, includeType: boolean): EnrichedWorkItem {
    return {
        id: cache.id,
        title: cache.title,
        state: cache.state,
        type: includeType ? cache.type : undefined,
        assignee: cache.assignee,
        changed: cache.changed,
        parentId: cache.parentId,
    };
}

function definitionsToColorMap(definitions: WorkItemTypeDefinition[]): Map<string, WorkItemTypeColor> {
    const map = new Map<string, WorkItemTypeColor>();

    for (const def of definitions) {
        map.set(def.name, {
            name: def.name,
            color: def.color,
            icon: def.icon,
        });
    }

    return map;
}
