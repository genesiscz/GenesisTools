export type SearchMode = "auto" | "fulltext" | "hybrid" | "vector";
export type ResolvedMethod = "bm25" | "rrf" | "cosine";

const MODE_DESCRIPTIONS: Record<SearchMode, string> = {
    fulltext: "BM25",
    hybrid: "BM25 + cosine via RRF",
    vector: "cosine",
    auto: "auto",
};

export function formatSearchLabelStart(mode: SearchMode): string {
    return `Searching mail index (${mode}: ${MODE_DESCRIPTIONS[mode]})…`;
}

export function formatSearchLabelStop(
    mode: SearchMode,
    method: ResolvedMethod | undefined,
    count: number,
    ms: number
): string {
    const m = method ? method.toUpperCase() : MODE_DESCRIPTIONS[mode];
    return `${count} matches in ${(ms / 1000).toFixed(1)}s (${m})`;
}

export function formatSearchLabelEmpty(mode: SearchMode): string {
    return `0 matches in mail index (${mode}: ${MODE_DESCRIPTIONS[mode]})`;
}

export function formatFallbackStart(): string {
    return "Mail index missing — searching via Spotlight + subject/sender LIKE…";
}

export function formatFallbackStop(count: number, ms: number): string {
    return `${count} matches via Spotlight + LIKE in ${(ms / 1000).toFixed(1)}s — run "tools macos mail index sync" for proper FTS`;
}
