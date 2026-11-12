import { describe, expect, test } from "bun:test";
import { type AsrWordTiming, alignWordTimings, WORD_TIMING_ALIGNMENT_LIMITS } from "./word-timings";

function timed(texts: string[]): AsrWordTiming[] {
    return texts.map((text, index) => ({ text, startSec: index, endSec: index + 0.5 }));
}

function align(text: string, words: AsrWordTiming[]) {
    return alignWordTimings({
        lines: [{ id: "line-a", text, startSec: 0, endSec: 20 }],
        words,
        window: { fromSec: 0, toSec: 20 },
    });
}

function matchedText(text: string, words: AsrWordTiming[]): string[] {
    return align(text, words).lines.flatMap((line) =>
        line.words.map((word) => text.slice(word.range.location, word.range.location + word.range.length))
    );
}

describe("exact word timing alignment", () => {
    test("maps only exact unique words through insertions and deletions", () => {
        const text = "alpha extra beta gamma";
        const result = align(text, timed(["alpha", "beta", "discarded", "gamma"]));
        expect(matchedText(text, timed(["alpha", "beta", "discarded", "gamma"]))).toEqual(["alpha", "beta", "gamma"]);
        expect(result.coverage).toEqual({
            eligibleWords: 4,
            matchedWords: 3,
            ambiguousWords: 0,
            unmatchedWords: 1,
            invalidAsrWords: 0,
            invalidLinesSkipped: 0,
            boundaryLinesSkipped: 0,
        });
        expect(result.lines[0]?.id).toBe("line-a");
    });

    test.each([
        ["a a", ["a"], 2],
        ["a", ["a", "a"], 1],
        ["a b", ["b", "a"], 2],
    ] as const)("rejects ambiguous optimal matches for %s against %j", (text, rawWords, ambiguous) => {
        const result = align(text, timed([...rawWords]));
        expect(result.lines).toEqual([]);
        expect(result.coverage.ambiguousWords).toBe(ambiguous);
        expect(result.coverage.matchedWords).toBe(0);
    });

    test("repetition is allowed when every optimal alignment forces the same occurrences", () => {
        expect(matchedText("a a", timed(["a", "a"]))).toEqual(["a", "a"]);
        expect(matchedText("a b a", timed(["a", "a"]))).toEqual(["a", "a"]);
        expect(matchedText("a a anchor", timed(["a", "anchor"]))).toEqual(["anchor"]);
    });

    test("preserves UTF-16 ranges through emoji, quotes, combining marks and compatibility normalization", () => {
        const text = "😀 „ŽLUTÝ!“ z\u030clutý Ｆｏｏ foo-bar 200.";
        const result = align(text, timed(["žlutý", "žlutý", "foo", "foo-bar", "200"]));
        const words = result.lines[0]?.words ?? [];
        expect(words.map((word) => text.slice(word.range.location, word.range.location + word.range.length))).toEqual([
            "ŽLUTÝ",
            "z\u030clutý",
            "Ｆｏｏ",
            "foo-bar",
            "200",
        ]);
        expect(words[0]?.range).toEqual({ location: 4, length: 5 });
        expect(words[1]?.range.length).toBe(6);
    });

    test.each([
        ["C", "C++"],
        ["C", "C#"],
        ["C++", "C"],
        ["C#", "C"],
        ["C++", "C#"],
        ["C#", "C++"],
        ["_value", "value"],
        ["+200", "200"],
    ])("does not conflate attached code symbols in %s and %s", (corrected, recognized) => {
        expect(matchedText(corrected, timed([recognized]))).toEqual([]);
    });

    test("retains code symbols and complete UTF-16 ranges inside prose punctuation", () => {
        const text = "„C++“, C#; C. Ｃ＋＋! _value +200";
        expect(matchedText(text, timed(["C++", "C#", "C", "C++", "_value", "+200"]))).toEqual([
            "C++",
            "C#",
            "C",
            "Ｃ＋＋",
            "_value",
            "+200",
        ]);
    });

    test("skips standalone code symbols and emoji", () => {
        const result = align("++ # 😀 © _", timed(["++", "#", "😀", "©", "_"]));
        expect(result.lines).toEqual([]);
        expect(result.coverage.eligibleWords).toBe(0);
        expect(result.coverage.invalidAsrWords).toBe(5);
    });

    test("does not remove diacritics, change internal spelling or expand numbers", () => {
        expect(matchedText("žlutý foo-bar 200 autobus", timed(["zluty", "foobar", "dvě stě", "auto", "bus"]))).toEqual(
            []
        );
        expect(
            align("žlutý foo-bar 200 autobus", timed(["zluty", "foobar", "dvě stě", "auto", "bus"])).coverage
                .invalidAsrWords
        ).toBe(1);
    });

    test("temporal containment resolves repeated words on distinct lines", () => {
        const result = alignWordTimings({
            lines: [
                { text: "ano", startSec: 0, endSec: 1 },
                { id: "second", text: "ano", startSec: 1, endSec: 2 },
            ],
            words: [{ text: "ano", startSec: 1.2, endSec: 1.5 }],
            window: { fromSec: 0, toSec: 2 },
        });
        expect(result.lines).toEqual([
            { lineIndex: 1, id: "second", words: [{ range: { location: 0, length: 3 }, startSec: 1.2, endSec: 1.5 }] },
        ]);
        expect(result.coverage.unmatchedWords).toBe(1);
    });

    test("applies the source offset once and retains exact original times", () => {
        const lines = Object.freeze([Object.freeze({ text: "alpha", startSec: 100, endSec: 102 })]);
        const words = Object.freeze([Object.freeze({ text: "alpha", startSec: 0.25, endSec: 0.75 })]);
        const result = alignWordTimings({ lines, words, window: { fromSec: 100, toSec: 102 } });
        expect(result.lines[0]?.words).toEqual([
            { range: { location: 0, length: 5 }, startSec: 100.25, endSec: 100.75 },
        ]);
        expect(words[0]?.startSec).toBe(0.25);
        expect(
            alignWordTimings({
                lines,
                words: [{ text: "alpha", startSec: 100.25, endSec: 100.75 }],
                window: { fromSec: 100, toSec: 102 },
            }).lines
        ).toEqual([]);
    });

    test("rejects an offset that collapses a positive relative interval through numeric precision", () => {
        const result = alignWordTimings({
            lines: [{ text: "a", startSec: 1e15, endSec: 1e15 + 1 }],
            words: [{ text: "a", startSec: 0.001, endSec: 0.002 }],
            window: { fromSec: 1e15, toSec: 1e15 + 1 },
        });
        expect(result.lines).toEqual([]);
        expect(result.coverage.invalidAsrWords).toBe(1);
    });

    test("skips partial boundary lines and never clips a crossing word", () => {
        const result = alignWordTimings({
            lines: [
                { text: "outside", startSec: 0, endSec: 1 },
                { text: "first", startSec: 1, endSec: 3 },
                { text: "middle crossing", startSec: 3, endSec: 6 },
                { text: "last", startSec: 6, endSec: 9 },
            ],
            words: [
                { text: "first", startSec: 0, endSec: 0.5 },
                { text: "middle", startSec: 1.2, endSec: 1.5 },
                { text: "crossing", startSec: 3.5, endSec: 4.2 },
                { text: "last", startSec: 4.3, endSec: 4.8 },
            ],
            window: { fromSec: 2, toSec: 7 },
        });
        expect(result.coverage.boundaryLinesSkipped).toBe(2);
        expect(result.lines.map((line) => line.lineIndex)).toEqual([2]);
        expect(result.lines[0]?.words).toEqual([{ range: { location: 0, length: 6 }, startSec: 3.2, endSec: 3.5 }]);
    });

    test.each([
        { text: "a", startSec: NaN, endSec: 0.5 },
        { text: "a", startSec: 0, endSec: Infinity },
        { text: "a", startSec: -0.1, endSec: 0.5 },
        { text: "a", startSec: 0.5, endSec: 0.5 },
        { text: "a", startSec: 1, endSec: 0.5 },
        { text: "a", startSec: 19.5, endSec: 20.1 },
        { text: "a", startSec: 0, endSec: 1.01 },
        { text: "two words", startSec: 0, endSec: 0.5 },
        { text: "…", startSec: 0, endSec: 0.5 },
        { text: "", startSec: 0, endSec: 0.5 },
    ])("rejects malformed or pause-spanning ASR interval %j", (word) => {
        const result = align("a", [word]);
        expect(result.lines).toEqual([]);
        expect(result.coverage.invalidAsrWords).toBe(1);
    });

    test("rejects overlap and backwards words without shifting subsequent intervals", () => {
        const result = align("a b c d", [
            { text: "a", startSec: 1, endSec: 1.5 },
            { text: "b", startSec: 1.4, endSec: 1.8 },
            { text: "c", startSec: 0, endSec: 0.5 },
            { text: "d", startSec: 2, endSec: 3 },
        ]);
        expect(result.coverage.invalidAsrWords).toBe(2);
        expect(result.lines[0]?.words.map((word) => word.startSec)).toEqual([1, 2]);
        expect(result.lines[0]?.words[1]?.endSec).toBe(3);
    });

    test("untimed, invalid and overlapping lines remain untimed", () => {
        const result = alignWordTimings({
            lines: [
                { text: "a" },
                { text: "a", startSec: 0, endSec: 0 },
                { text: "a", startSec: NaN, endSec: 2 },
                { text: "a", startSec: 0, endSec: 1 },
                { text: "b", startSec: 0.5, endSec: 2 },
            ],
            words: timed(["a", "b"]),
            window: { fromSec: 0, toSec: 3 },
        });
        expect(result.coverage.invalidLinesSkipped).toBe(4);
        expect(result.lines.map((line) => line.lineIndex)).toEqual([3]);
    });

    test.each([
        { fromSec: -1, toSec: 1 },
        { fromSec: 0, toSec: 0 },
        { fromSec: 1, toSec: 0 },
        { fromSec: NaN, toSec: 1 },
        { fromSec: 0, toSec: Infinity },
        { fromSec: 0, toSec: 20.01 },
    ])("rejects invalid window %j rather than clamping it", (window) => {
        expect(() => alignWordTimings({ lines: [], words: [], window })).toThrow(RangeError);
    });

    test("accepts the word-count bound with unique monotone occurrences", () => {
        const count = WORD_TIMING_ALIGNMENT_LIMITS.words;
        const result = align(
            Array.from({ length: count }, () => "a").join(" "),
            Array.from({ length: count }, (_, i) => ({ text: "a", startSec: i / 32, endSec: (i + 0.5) / 32 }))
        );
        expect(result.coverage.matchedWords).toBe(count);
        expect(result.coverage.ambiguousWords).toBe(0);
        expect(result.lines[0]?.words.at(-1)?.range).toEqual({ location: 2 * (count - 1), length: 1 });
    });

    test("rejects oversized inputs rather than truncating them", () => {
        const limit = WORD_TIMING_ALIGNMENT_LIMITS;
        expect(() => align("a", timed(Array.from({ length: limit.words + 1 }, () => "a")))).toThrow(/ASR word limits/);
        expect(() => align(Array.from({ length: limit.words + 1 }, () => "a").join(" "), [])).toThrow(
            /corrected word limit/
        );
        expect(() => align("a".repeat(limit.textCodeUnits + 1), [])).toThrow(/text size limit/);
        expect(() =>
            alignWordTimings({
                lines: Array.from({ length: limit.lines + 1 }, () => ({ text: "a" })),
                words: [],
                window: { fromSec: 0, toSec: 1 },
            })
        ).toThrow(/line or ASR word limits/);
    });

    test("empty and punctuation-only inputs produce no invented timing", () => {
        expect(align("", []).lines).toEqual([]);
        expect(align("… 😀", []).coverage.eligibleWords).toBe(0);
        expect(align("a", []).coverage.unmatchedWords).toBe(1);
    });
});

/** Enumerate actual monotone pair sets independently of the production DP and intersect all maxima. */
function oracle(left: string[], right: string[]): string[] {
    let bestLength = -1;
    let forced = new Set<string>();
    const visit = (i: number, j: number, pairs: string[]) => {
        if (pairs.length > bestLength) {
            bestLength = pairs.length;
            forced = new Set(pairs);
        } else if (pairs.length === bestLength) {
            forced = new Set([...forced].filter((pair) => pairs.includes(pair)));
        }
        for (let a = i; a < left.length; a++) {
            for (let b = j; b < right.length; b++) {
                if (left[a] === right[b]) {
                    visit(a + 1, b + 1, [...pairs, `${a}:${b}`]);
                }
            }
        }
    };
    visit(0, 0, []);
    return [...forced].sort();
}

function binarySequences(maxLength: number): string[][] {
    const result: string[][] = [[]];
    for (let length = 1; length <= maxLength; length++) {
        for (let bits = 0; bits < 2 ** length; bits++) {
            result.push(Array.from({ length }, (_, i) => (bits & (1 << i) ? "a" : "b")));
        }
    }
    return result;
}

test("matches all-optimal-alignment intersection oracle for every binary sequence pair through length four", () => {
    const sequences = binarySequences(4);
    for (const left of sequences) {
        for (const right of sequences) {
            const result = align(left.join(" "), timed(right));
            const pairs = result.lines
                .flatMap((line) => line.words.map((word) => `${word.range.location / 2}:${word.startSec}`))
                .sort();
            expect(pairs).toEqual(oracle(left, right));
        }
    }
});
