/**
 * Azure DevOps CLI - URL parsing and query matching utilities
 */

import type { ParsedUrl, QueryInfo } from "@app/azure-devops/types";
import { similarityScore } from "@app/utils/fuzzy-match";

/**
 * Check if input looks like a GUID or URL (not a query name)
 */
export function isQueryIdOrUrl(input: string): boolean {
    // GUID pattern
    if (/^[a-f0-9-]{36}$/i.test(input)) {
        return true;
    }
    // URL pattern
    if (input.includes("query/")) {
        return true;
    }
    // Bare GUID without dashes
    if (/^[a-f0-9]{32}$/i.test(input)) {
        return true;
    }
    return false;
}

export function extractQueryId(input: string): string {
    const match = input.match(/query\/([a-f0-9-]+)/i) || input.match(/^([a-f0-9-]+)$/i);

    if (!match) {
        throw new Error(`Invalid query URL/ID: ${input}`);
    }
    return match[1];
}

/**
 * Find the best matching query by name from a list of queries
 * Returns the query if a good match is found, null otherwise
 * @param recentQueryIds - Optional set of query IDs that have been recently used (get 0.15 score boost)
 */
export function findQueryByName(
    searchName: string,
    queries: QueryInfo[],
    recentQueryIds?: Set<string>
): { query: QueryInfo; score: number; alternatives: QueryInfo[] } | null {
    // Filter to non-folder queries only
    const actualQueries = queries.filter((q) => !q.isFolder);

    if (actualQueries.length === 0) {
        return null;
    }

    // Calculate scores for all queries
    const scored = actualQueries.map((q) => {
        // Check exact match first (case-insensitive)
        if (q.name.toLowerCase() === searchName.toLowerCase()) {
            return { query: q, score: 1.0 };
        }

        // Check if search term is contained in query name
        const containsScore = q.name.toLowerCase().includes(searchName.toLowerCase())
            ? 0.8 + (searchName.length / q.name.length) * 0.15
            : 0;

        // Calculate Levenshtein similarity
        const levScore = similarityScore(searchName, q.name);

        // Also check against full path
        const pathScore = similarityScore(searchName, q.path) * 0.8;

        // Take the best score
        let finalScore = Math.max(containsScore, levScore, pathScore);

        // Boost score for recently-used queries (add 0.15 to favor them)
        if (recentQueryIds?.has(q.id)) {
            finalScore = Math.min(1.0, finalScore + 0.15);
        }

        return { query: q, score: finalScore };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Get top match
    const best = scored[0];

    // If best score is too low, no good match
    if (best.score < 0.3) {
        return null;
    }

    // Get alternatives (other high-scoring matches)
    const alternatives = scored
        .slice(1, 4)
        .filter((s) => s.score >= 0.3)
        .map((s) => s.query);

    return {
        query: best.query,
        score: best.score,
        alternatives,
    };
}

export function extractWorkItemIds(input: string): number[] {
    const parts = input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const ids: number[] = [];

    for (const part of parts) {
        const match = part.match(/workItems?\/(\d+)/i) || part.match(/edit\/(\d+)/i) || part.match(/^(\d+)$/);

        if (!match) {
            throw new Error(`Invalid work item URL/ID: ${part}`);
        }
        ids.push(parseInt(match[1], 10));
    }

    return ids;
}

export function extractDashboardId(input: string): string {
    const match = input.match(/dashboard\/([a-f0-9-]+)/i) || input.match(/^([a-f0-9-]+)$/i);

    if (!match) {
        throw new Error(`Invalid dashboard URL/ID: ${input}`);
    }
    return match[1];
}

export function parseAzureDevOpsUrl(url: string): ParsedUrl {
    const devAzureMatch = url.match(/https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)/i);

    if (devAzureMatch) {
        return {
            org: `https://dev.azure.com/${devAzureMatch[1]}`,
            project: decodeURIComponent(devAzureMatch[2]),
        };
    }

    const vsMatch = url.match(/https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)/i);

    if (vsMatch) {
        return {
            org: `https://dev.azure.com/${vsMatch[1]}`,
            project: decodeURIComponent(vsMatch[2]),
        };
    }

    throw new Error(
        `Could not parse Azure DevOps URL: ${url}\n\nSupported formats:\n  https://dev.azure.com/{org}/{project}/...\n  https://{org}.visualstudio.com/{project}/...`
    );
}
