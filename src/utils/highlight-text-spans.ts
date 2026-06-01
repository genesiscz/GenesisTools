import { findTokenMatches } from "./fuzzy-tokens";

export interface HighlightTextSpan {
    text: string;
    highlight: boolean;
}

export function splitTextByHighlights(text: string, tokens: string[]): HighlightTextSpan[] {
    if (!text) {
        return [];
    }

    if (tokens.length === 0) {
        return [{ text, highlight: false }];
    }

    const matches = findTokenMatches(text, tokens);

    if (matches.length === 0) {
        return [{ text, highlight: false }];
    }

    const spans: HighlightTextSpan[] = [];
    let cursor = 0;

    for (const match of matches) {
        if (match.start > cursor) {
            spans.push({ text: text.slice(cursor, match.start), highlight: false });
        }

        spans.push({ text: text.slice(match.start, match.end), highlight: true });
        cursor = match.end;
    }

    if (cursor < text.length) {
        spans.push({ text: text.slice(cursor), highlight: false });
    }

    return spans;
}
