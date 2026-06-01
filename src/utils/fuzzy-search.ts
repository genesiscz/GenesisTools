import { scoreEntry, tokenizeSearch } from "./fuzzy-tokens";

export interface FuzzySearchByHaystackResult<T> {
    items: T[];
    tokens: string[];
}

export interface FuzzySearchHit<T> {
    item: T;
    index: number;
    isMatch: boolean;
    score: number;
}

export interface FuzzySearchWithContextResult<T> {
    hits: FuzzySearchHit<T>[];
    tokens: string[];
    matchCount: number;
}

export function fuzzySearchByHaystack<T>(
    items: readonly T[],
    query: string,
    haystack: (item: T) => string
): FuzzySearchByHaystackResult<T> {
    const tokens = tokenizeSearch(query);

    if (tokens.length === 0) {
        return { items: [...items], tokens: [] };
    }

    const ranked = items
        .map((entry) => ({ entry, score: scoreEntry(haystack(entry), tokens) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || 0);

    return {
        items: ranked.map((row) => row.entry),
        tokens,
    };
}

export function fuzzySearchWithContext<T>({
    items,
    query,
    haystack,
    contextLines = 0,
}: {
    items: readonly T[];
    query: string;
    haystack: (item: T, index: number) => string;
    contextLines?: number;
}): FuzzySearchWithContextResult<T> {
    const tokens = tokenizeSearch(query);

    if (tokens.length === 0) {
        return {
            hits: items.map((item, index) => ({ item, index, isMatch: false, score: 1 })),
            tokens: [],
            matchCount: 0,
        };
    }

    const matches: Array<{ index: number; score: number }> = [];

    for (let index = 0; index < items.length; index++) {
        const score = scoreEntry(haystack(items[index], index), tokens);

        if (score > 0) {
            matches.push({ index, score });
        }
    }

    matches.sort((a, b) => b.score - a.score || a.index - b.index);

    const visible = new Set<number>();

    for (const { index } of matches) {
        visible.add(index);

        for (let offset = 1; offset <= contextLines; offset++) {
            if (index - offset >= 0) {
                visible.add(index - offset);
            }

            if (index + offset < items.length) {
                visible.add(index + offset);
            }
        }
    }

    const matchSet = new Set(matches.map((m) => m.index));
    const scoreByIndex = new Map(matches.map((m) => [m.index, m.score]));

    const hits = [...visible]
        .sort((a, b) => a - b)
        .map((index) => ({
            item: items[index],
            index,
            isMatch: matchSet.has(index),
            score: scoreByIndex.get(index) ?? 0,
        }));

    return {
        hits,
        tokens,
        matchCount: matches.length,
    };
}
