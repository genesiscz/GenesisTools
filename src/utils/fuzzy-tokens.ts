import { similarityScore } from "./fuzzy-match";

const SEP = /[\\\s\-:/,.;_]+/;

/** Pasted IDs/tokens without spaces — do not split on `:`, `-`, `_` inside the blob. */
const LITERAL_BLOB_MIN_LEN = 24;

function isWeakToken(token: string): boolean {
    if (token.length < 2) {
        return true;
    }

    if (/^\d+$/.test(token) && token.length < 4) {
        return true;
    }

    return false;
}

export function tokenizeSearch(input: string): string[] {
    const trimmed = input.trim();

    if (trimmed.length === 0) {
        return [];
    }

    if (!/\s/.test(trimmed) && trimmed.length >= LITERAL_BLOB_MIN_LEN) {
        return [trimmed.toLowerCase()];
    }

    return trimmed
        .split(SEP)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => !isWeakToken(t));
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
        let idx = lower.indexOf(token);

        while (idx !== -1) {
            spans.push({ token, start: idx, end: idx + token.length });
            idx = lower.indexOf(token, idx + token.length);
        }

        if (spans.some((s) => s.token === token)) {
            continue;
        }

        if (token.length < 5) {
            continue;
        }

        for (const m of lower.matchAll(/[^\\\s\-:/,.;_]+/g)) {
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

    const uniqueTokens = [...new Set(tokens)];
    const matches = findTokenMatches(haystack, uniqueTokens);
    const distinctTokensMatched = new Set(matches.map((m) => m.token)).size;

    return distinctTokensMatched / uniqueTokens.length;
}
