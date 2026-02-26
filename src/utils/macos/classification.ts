// src/utils/macos/classification.ts

import { textDistance } from "./nlp";
import type { ClassificationItem, ClassificationResult, TextItem } from "./types";

export interface ClassifyOptions {
    /** BCP-47 language code. Default: "en" */
    language?: string;
    /** Concurrency limit for batch operations. Default: 5 */
    concurrency?: number;
}

/**
 * Classify text into one of N candidate categories using semantic distance.
 * The category whose embedding is closest (lowest cosine distance) to the
 * input text wins.
 *
 * Works best when category labels are descriptive phrases, not single words.
 *
 * @param text       - Text to classify
 * @param categories - List of category labels (e.g. ["bug fix", "new feature", "refactoring"])
 *
 * @example
 * const result = await classifyText(
 *   "fix crash when user logs out",
 *   ["bug fix", "new feature", "documentation", "refactoring"]
 * );
 * // → { category: "bug fix", confidence: 0.82, scores: [...] }
 */
export async function classifyText(
    text: string,
    categories: string[],
    options: ClassifyOptions = {}
): Promise<ClassificationResult> {
    if (categories.length === 0) {
        throw new Error("classifyText: categories must be non-empty");
    }

    const language = options.language ?? "en";

    const scored = await Promise.all(
        categories.map(async (category) => {
            try {
                const { distance } = await textDistance(text, category, language, "sentence");
                return { category, score: Math.max(0, 1 - distance / 2) };
            } catch {
                return { category, score: 0 };
            }
        })
    );

    // Sort descending by score (highest confidence first)
    scored.sort((a, b) => b.score - a.score);

    return {
        category: scored[0].category,
        confidence: scored[0].score,
        scores: scored,
    };
}

/**
 * Classify a batch of text items into one of N categories.
 * Returns results in the same order as the input.
 *
 * @example
 * const commits = [
 *   { id: "c1", text: "fix null pointer in login handler" },
 *   { id: "c2", text: "add user profile photo upload" },
 *   { id: "c3", text: "rename variable for clarity" },
 * ];
 * const results = await classifyBatch(commits, ["bug fix", "new feature", "refactoring"]);
 * // → [
 * //     { id: "c1", category: "bug fix",     confidence: 0.85, scores: [...] },
 * //     { id: "c2", category: "new feature", confidence: 0.79, scores: [...] },
 * //     { id: "c3", category: "refactoring", confidence: 0.71, scores: [...] },
 * //   ]
 */
export async function classifyBatch<IdType = string>(
    items: TextItem<IdType>[],
    categories: string[],
    options: ClassifyOptions = {}
): Promise<Array<ClassificationItem<IdType>>> {
    if (categories.length === 0) {
        throw new Error("classifyBatch: categories must be non-empty");
    }

    const concurrency = options.concurrency ?? 5;
    const results: Array<ClassificationItem<IdType>> = [];

    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                try {
                    const classification = await classifyText(item.text, categories, options);
                    return { id: item.id, ...classification };
                } catch {
                    return {
                        id: item.id,
                        category: categories[0],
                        confidence: 0,
                        scores: categories.map((c) => ({ category: c, score: 0 })),
                    };
                }
            })
        );
        results.push(...chunkResults);
    }

    return results;
}

/**
 * Group a list of items by their classified category.
 * Returns a map of category → items.
 *
 * @example
 * const grouped = await groupByCategory(commits, ["bug fix", "new feature", "docs"]);
 * // → { "bug fix": [...], "new feature": [...], "docs": [...] }
 */
export async function groupByCategory<T extends { text: string }>(
    items: T[],
    categories: string[],
    options: ClassifyOptions = {}
): Promise<Record<string, T[]>> {
    const concurrency = options.concurrency ?? 5;
    const groups: Record<string, T[]> = {};
    for (const cat of categories) {
        groups[cat] = [];
    }

    for (let i = 0; i < items.length; i += concurrency) {
        const chunk = items.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(async (item) => {
                try {
                    const { category } = await classifyText(item.text, categories, options);
                    return { item, category };
                } catch {
                    return { item, category: categories[0] };
                }
            })
        );
        for (const { item, category } of chunkResults) {
            if (!groups[category]) {
                groups[category] = [];
            }
            groups[category].push(item);
        }
    }

    return groups;
}
