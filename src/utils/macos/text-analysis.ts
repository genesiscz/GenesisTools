// src/utils/macos/text-analysis.ts

import { analyzeSentiment, detectLanguage, extractEntities, textDistance } from "./nlp";
import type { Cluster, LanguageItem, NamedEntity, ScoredItem, SentimentItem, SentimentResult, TextItem } from "./types";

// ─── Semantic Ranking ─────────────────────────────────────────────────────────

export interface RankOptions {
    /** BCP-47 language code. Default: "en" */
    language?: string;
    /** Max results to return. Default: all */
    maxResults?: number;
    /** Maximum cosine distance to include (0–2). Default: 2.0 (include all) */
    maxDistance?: number;
}

/**
 * Rank a list of text items by semantic similarity to a query.
 * Items with the lowest cosine distance to the query come first.
 *
 * @example
 * const emails = [
 *   { id: "1", text: "Q4 budget review meeting tomorrow" },
 *   { id: "3", text: "Annual financial planning session" },
 * ];
 * const ranked = await rankBySimilarity("budget planning", emails);
 */
export async function rankBySimilarity<T extends { text: string }>(
    query: string,
    items: T[],
    options: RankOptions = {}
): Promise<Array<ScoredItem<T>>> {
    if (items.length === 0) return [];

    const language = options.language ?? "en";

    const scored = await Promise.all(
        items.map(async (item) => {
            try {
                const result = await textDistance(query, item.text, language, "sentence");
                return { item, score: result.distance };
            } catch {
                return { item, score: 2.0 };
            }
        })
    );

    scored.sort((a, b) => a.score - b.score);

    let results = scored;
    if (options.maxDistance !== undefined) {
        results = results.filter((r) => r.score <= options.maxDistance!);
    }
    if (options.maxResults !== undefined) {
        results = results.slice(0, options.maxResults);
    }

    return results;
}

// ─── Batch Sentiment ──────────────────────────────────────────────────────────

export interface BatchSentimentOptions {
    /** Filter output to only items matching this label */
    filterLabel?: SentimentResult["label"];
    /** Concurrency limit to avoid overwhelming darwinkit. Default: 5 */
    concurrency?: number;
}

/**
 * Analyze sentiment for a batch of text items.
 * Returns results in the same order as the input.
 */
export async function batchSentiment<IdType = string>(
    items: TextItem<IdType>[],
    options: BatchSentimentOptions = {}
): Promise<Array<SentimentItem<IdType>>> {
    const concurrency = options.concurrency ?? 5;
    const results: Array<SentimentItem<IdType>> = [];

    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                try {
                    const sentiment = await analyzeSentiment(item.text);
                    return { id: item.id, ...sentiment };
                } catch {
                    return { id: item.id, score: 0, label: "neutral" as const };
                }
            })
        );
        results.push(...chunkResults);
    }

    if (options.filterLabel) {
        return results.filter((r) => r.label === options.filterLabel);
    }

    return results;
}

// ─── Language Grouping ────────────────────────────────────────────────────────

export interface GroupByLanguageOptions {
    /** Minimum confidence to trust the detected language. Default: 0.7 */
    minConfidence?: number;
    /** Concurrency limit. Default: 5 */
    concurrency?: number;
}

/**
 * Detect language for each item and group them by language code.
 * Items below minConfidence are grouped under "unknown".
 */
export async function groupByLanguage<IdType = string>(
    items: TextItem<IdType>[],
    options: GroupByLanguageOptions = {}
): Promise<Record<string, Array<LanguageItem<IdType>>>> {
    const concurrency = options.concurrency ?? 5;
    const minConfidence = options.minConfidence ?? 0.7;
    const groups: Record<string, Array<LanguageItem<IdType>>> = {};

    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                try {
                    const lang = await detectLanguage(item.text);
                    const language = lang.confidence >= minConfidence ? lang.language : "unknown";
                    return { id: item.id, language, confidence: lang.confidence };
                } catch {
                    return { id: item.id, language: "unknown", confidence: 0 };
                }
            })
        );
        for (const result of chunkResults) {
            const key = result.language;
            if (!groups[key]) groups[key] = [];
            groups[key].push(result);
        }
    }

    return groups;
}

// ─── Entity Extraction (Batch) ────────────────────────────────────────────────

export interface TextEntities<IdType = string> {
    id: IdType;
    entities: NamedEntity[];
}

/**
 * Extract named entities from a batch of text items.
 */
export async function extractEntitiesBatch<IdType = string>(
    items: TextItem<IdType>[],
    concurrency = 5
): Promise<Array<TextEntities<IdType>>> {
    const results: Array<TextEntities<IdType>> = [];

    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                try {
                    const entities = await extractEntities(item.text);
                    return { id: item.id, entities };
                } catch {
                    return { id: item.id, entities: [] };
                }
            })
        );
        results.push(...chunkResults);
    }

    return results;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export interface DeduplicateOptions {
    /** Cosine distance threshold — items closer than this are considered duplicates. Default: 0.3 */
    threshold?: number;
    /** BCP-47 language code. Default: "en" */
    language?: string;
}

/**
 * Remove semantically duplicate items from a list.
 * Keeps the first occurrence when two items are within `threshold` cosine distance.
 *
 * O(n²) — suitable for lists up to ~200 items.
 *
 * @example
 * const items = [
 *   { text: "fix authentication bug" },
 *   { text: "authentication issue fix" },   // duplicate → removed
 *   { text: "add dark mode support" },
 * ];
 * const deduped = await deduplicateTexts(items);
 * // → [ { text: "fix authentication bug" }, { text: "add dark mode support" } ]
 */
export async function deduplicateTexts<T extends { text: string }>(
    items: T[],
    options: DeduplicateOptions = {}
): Promise<T[]> {
    if (items.length <= 1) return [...items];
    const threshold = options.threshold ?? 0.3;
    const language = options.language ?? "en";

    const kept: T[] = [];

    for (const item of items) {
        let isDuplicate = false;
        for (const keptItem of kept) {
            try {
                const { distance } = await textDistance(item.text, keptItem.text, language, "sentence");
                if (distance <= threshold) {
                    isDuplicate = true;
                    break;
                }
            } catch {
                // On error, assume not a duplicate
            }
        }
        if (!isDuplicate) kept.push(item);
    }

    return kept;
}

// ─── Clustering ───────────────────────────────────────────────────────────────

export interface ClusterOptions {
    /** Cosine distance threshold — items closer than this join the same cluster. Default: 0.5 */
    threshold?: number;
    /** BCP-47 language code. Default: "en" */
    language?: string;
}

/**
 * Group semantically similar items into clusters using greedy single-linkage.
 * Each item is assigned to the first cluster whose seed is within `threshold` distance.
 * Items that don't fit any existing cluster start a new one.
 *
 * O(n²) — suitable for lists up to ~200 items.
 *
 * @example
 * const commits = [
 *   { text: "fix login bug" },
 *   { text: "fix authentication error" },   // → same cluster as above
 *   { text: "add dark mode" },
 *   { text: "implement dark theme" },        // → same cluster as above
 * ];
 * const clusters = await clusterBySimilarity(commits);
 * // → [
 * //     { items: [fix login bug, fix auth error], centroid: "fix login bug" },
 * //     { items: [add dark mode, implement dark theme], centroid: "add dark mode" },
 * //   ]
 */
export async function clusterBySimilarity<T extends { text: string }>(
    items: T[],
    options: ClusterOptions = {}
): Promise<Array<Cluster<T>>> {
    if (items.length === 0) return [];

    const threshold = options.threshold ?? 0.5;
    const language = options.language ?? "en";

    const clusterSeeds: T[] = [];
    const clusterBuckets: T[][] = [];
    const assigned = new Set<number>();

    for (let i = 0; i < items.length; i++) {
        if (assigned.has(i)) continue;

        // Start a new cluster with items[i] as seed
        clusterSeeds.push(items[i]);
        const bucket: T[] = [items[i]];
        assigned.add(i);

        // Greedily add unassigned items within threshold of this seed
        for (let j = i + 1; j < items.length; j++) {
            if (assigned.has(j)) continue;
            try {
                const { distance } = await textDistance(items[i].text, items[j].text, language, "sentence");
                if (distance <= threshold) {
                    bucket.push(items[j]);
                    assigned.add(j);
                }
            } catch {
                // On error, skip this pair
            }
        }

        clusterBuckets.push(bucket);
    }

    return clusterBuckets.map((clusterItems) => ({
        items: clusterItems,
        centroid: clusterItems[0].text,
    }));
}
