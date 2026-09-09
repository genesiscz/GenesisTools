import { expect, test } from "bun:test";
import { HistoryOccurrenceCounter } from "./search-occurrences";

function legacyContentScore(query: string, text: string): number {
    if (!query) {
        return 0;
    }

    const lower = text.toLowerCase();
    let score = 0;
    for (const word of query.toLowerCase().split(/\s+/)) {
        let occurrences = 0;
        let position = 0;

        // biome-ignore lint/suspicious/noAssignInExpressions: mirrors the frozen legacy scoring loop exactly
        while ((position = lower.indexOf(word, position)) !== -1 && occurrences < 10) {
            occurrences++;
            position += word.length;
        }

        score += occurrences;
    }
    return score;
}

function counterScore(query: string, chunks: string[]): number {
    const counter = new HistoryOccurrenceCounter(query);
    for (const chunk of chunks) {
        counter.append(chunk);
    }
    return counter.score;
}

test("streaming occurrence counts preserve legacy scores for repeated words, whitespace, overlaps, unicode, and caps", () => {
    const cases = [
        { query: "alpha alpha", text: "alpha alpha alpha", expected: 6 },
        { query: "  alpha   beta  ", text: "alpha beta alpha", expected: 23 },
        { query: "ana", text: "banana ana", expected: 2 },
        { query: "ŽLUŤOUČKÝ", text: "žluťoučký ŽLUŤOUČKÝ", expected: 2 },
        { query: "alpha", text: "alpha ".repeat(14), expected: 10 },
        { query: "", text: "alpha", expected: 0 },
    ];

    for (const { query, text, expected } of cases) {
        expect(legacyContentScore(query, text)).toBe(expected);
        expect(counterScore(query, [text])).toBe(expected);
    }
});

test("streaming occurrence counts match whole-text legacy scoring at every possible chunk boundary", () => {
    const cases = [
        { query: "alpha beta", text: "alpha beta alpha beta" },
        { query: "ana", text: "bananana" },
        { query: "Žluť", text: "xŽluťoučký Žluť" },
        { query: "  alpha  ", text: "alphaalpha" },
    ];

    for (const { query, text } of cases) {
        const expected = legacyContentScore(query, text);
        for (let boundary = 0; boundary <= text.length; boundary++) {
            expect(counterScore(query, [text.slice(0, boundary), text.slice(boundary)])).toBe(expected);
        }
    }
});

test("streaming occurrence counts remain equivalent across arbitrary multi-chunk boundaries", () => {
    const query = "needle other";
    const chunks = ["nee", "dle and oth", "er needle oth", "er needle"];
    const text = chunks.join("");

    expect(counterScore(query, chunks)).toBe(legacyContentScore(query, text));
});
