import { similarityScore } from "./fuzzy-match";

const SEP = /[\s\-:/,.;_]+/;

export function tokenizeSearch(input: string): string[] {
    return input
        .split(SEP)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
}

export interface TokenMatch {
    token: string;
    start: number;
    end: number;
}

export function findTokenMatches(haystack: string, tokens: string[], threshold = 0.7): TokenMatch[] {
    const lower = haystack.toLowerCase();
    const spans: TokenMatch[] = [];

    for (const token of tokens) {
        let idx = 0;

        while ((idx = lower.indexOf(token, idx)) !== -1) {
            spans.push({ token, start: idx, end: idx + token.length });
            idx += token.length;
        }

        if (spans.some((s) => s.token === token)) {
            continue;
        }

        for (const m of lower.matchAll(/[^\s\-:/,.;_]+/g)) {
            if (m.index === undefined) {
                continue;
            }

            const word = m[0];

            if (Math.abs(word.length - token.length) > 3) {
                continue;
            }

            if (similarityScore(word, token) >= threshold) {
                spans.push({ token, start: m.index, end: m.index + word.length });
            }
        }
    }

    spans.sort((a, b) => a.start - b.start);
    const merged: TokenMatch[] = [];

    for (const s of spans) {
        const last = merged[merged.length - 1];

        if (last && s.start < last.end) {
            last.end = Math.max(last.end, s.end);
        } else {
            merged.push({ ...s });
        }
    }

    return merged;
}

export function scoreEntry(haystack: string, tokens: string[]): number {
    if (tokens.length === 0) {
        return 1;
    }

    const matches = findTokenMatches(haystack, tokens);
    const distinctTokensMatched = new Set(matches.map((m) => m.token)).size;

    return distinctTokensMatched / tokens.length;
}
