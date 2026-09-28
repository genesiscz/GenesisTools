/**
 * Questions both implementations answer in `compare.ts`. `root` is relative to this checkout's root.
 * Budgets are hard stops per implementation, not targets: a case that hits one reports `request-limit`.
 */
export interface ComparisonCase {
    id: string;
    query: string;
    root: string;
    maxRequests: number;
    maxCostUsd: number;
}

export const COMPARISON_CASES: readonly ComparisonCase[] = [
    {
        id: "tools-control",
        query: "Where is tools control implemented command?",
        root: ".",
        maxRequests: 200,
        maxCostUsd: 0.1,
    },
    {
        id: "grep-cache-key",
        query: "How is the answer cache key for a Jev grep call built?",
        root: "src/jev/lib/grep",
        maxRequests: 200,
        maxCostUsd: 0.1,
    },
];
