import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { makeWordTimingArtifact, WordTimingCache, wordTimingFile, wordTimingHash } from "./word-timing-cache";
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

describe("derived word timing cache", () => {
    function fixture() {
        const root = mkdtempSync(join(tmpdir(), "meeting-word-cache-"));
        const audio = join(root, "audio.wav"),
            model = join(root, "weights.onnx");
        writeFileSync(audio, "audio-version-one");
        writeFileSync(model, "model-version-one");
        const lines = Array.from({ length: 751 }, (_, i) => ({
            id: `line-${i}`,
            speaker: "Example",
            text: "alpha beta",
            startSec: i * 3,
            endSec: i * 3 + 2,
        }));
        const input = {
            window: { fromSec: 300, toSec: 302 },
            audio: wordTimingFile(audio),
            modelFiles: [wordTimingFile(model)],
            modelId: "test/word-model",
            pcmSha256: "test-pcm",
            words: [{ text: "alpha", startSec: 0.2, endSec: 0.5 }],
            lines,
        };
        return { root, audio, model, lines, input, cache: new WordTimingCache(join(root, "derived")) };
    }

    test("missing cache reads leave the filesystem and transcript untouched", () => {
        const { cache, lines } = fixture();
        const result = cache.read(lines);
        expect(result.entries).toEqual(lines);
        expect(result.wordTimings.state).toBe("missing");
        expect(existsSync(cache.folder)).toBe(false);
    });

    test("return-to-window revision changes on publication and audio or model replacement", async () => {
        const { cache, input, audio, model } = fixture();
        const absent = cache.inputRevision();
        expect(absent).not.toBeNull();
        await cache.publish(makeWordTimingArtifact(input));
        const ready = cache.inputRevision();
        expect(ready).not.toBe(absent);
        expect(new WordTimingCache(cache.folder).inputRevision()).toBe(ready);
        writeFileSync(audio, "replaced audio");
        expect(cache.inputRevision()).not.toBe(ready);
        const refreshed = { ...input, audio: wordTimingFile(audio) };
        await cache.publish(makeWordTimingArtifact(refreshed));
        const next = cache.inputRevision();
        writeFileSync(model, "replaced model");
        expect(cache.inputRevision()).not.toBe(next);
    });

    test("old decoder evidence is stale and cannot be reused", async () => {
        const { cache, input, lines } = fixture();
        const artifact = makeWordTimingArtifact(input);
        await cache.publish(artifact);
        writeFileSync(
            join(cache.folder, `${wordTimingHash(input.window)}.json`),
            SafeJSON.stringify({ ...artifact, version: 1 })
        );
        expect(cache.read(lines).wordTimings.state).toBe("stale");
        expect(cache.reusable(input.window, input.audio, input.modelFiles, input.modelId)).toBeUndefined();
        expect(cache.inputRevision()).toBeNull();
    });

    test("reopening published evidence enriches only exact lines in a long transcript", async () => {
        const { cache, lines, input } = fixture();
        const artifact = makeWordTimingArtifact(input);
        await cache.publish(artifact);
        const reopened = new WordTimingCache(cache.folder).read(lines);
        expect(reopened.wordTimings.state).toBe("ready");
        expect(reopened.entries[100].words).toEqual([
            { range: { location: 0, length: 5 }, startSec: 300.2, endSec: 300.5, sourceId: artifact.source.id },
        ]);
        expect(reopened.entries[99]).toEqual(lines[99]);
        expect(reopened.entries[100].text).toBe(lines[100].text);
        expect(reopened.wordTimings.windows[0].coverage.matchedWords).toBe(1);
        expect(cache.reusable(input.window, input.audio, input.modelFiles, input.modelId)?.rawWords).toEqual(
            input.words
        );
        const file = join(cache.folder, `${wordTimingHash(input.window)}.json`);
        const written = readFileSync(file, "utf8");
        cache.read(lines);
        expect(readFileSync(file, "utf8")).toBe(written);
    });

    test("text changes invalidate display while retaining reusable acoustic evidence", async () => {
        const { cache, lines, input } = fixture();
        await cache.publish(makeWordTimingArtifact(input));
        const changed = lines.map((line, i) => (i === 100 ? { ...line, text: "corrected beta" } : line));
        expect(cache.read(changed).wordTimings.state).toBe("stale");
        expect(cache.read(changed).entries.every((line) => line.words === undefined)).toBe(true);
        expect(cache.reusable(input.window, input.audio, input.modelFiles, input.modelId)).toBeDefined();
    });

    test.each(["audio", "model"] as const)("changed %s invalidates evidence without rewriting it", async (part) => {
        const data = fixture();
        await data.cache.publish(makeWordTimingArtifact(data.input));
        writeFileSync(data[part], "replaced-with-another-version");
        expect(data.cache.read(data.lines).wordTimings.state).toBe("stale");
        expect(
            data.cache.reusable(data.input.window, data.input.audio, data.input.modelFiles, data.input.modelId)
        ).toBeUndefined();
    });

    test("cancellation or changed inputs cannot publish", async () => {
        const { cache, input, model } = fixture();
        const artifact = makeWordTimingArtifact(input);
        await expect(cache.publish(artifact, AbortSignal.abort())).rejects.toThrow();
        expect(existsSync(cache.folder)).toBe(false);
        writeFileSync(model, "changed-before-publication");
        await expect(cache.publish(artifact)).rejects.toThrow("changed before publication");
        expect(existsSync(cache.folder)).toBe(false);
    });

    test("concurrent windows retain both manifest entries", async () => {
        const { cache, input, lines } = fixture();
        await Promise.all([
            cache.publish(makeWordTimingArtifact(input)),
            cache.publish(makeWordTimingArtifact({ ...input, window: { fromSec: 303, toSec: 305 } })),
        ]);
        const reopened = new WordTimingCache(cache.folder).read(lines);
        expect(reopened.wordTimings.windows).toHaveLength(2);
        expect(reopened.entries[100].words).toHaveLength(1);
        expect(reopened.entries[101].words).toHaveLength(1);
    });

    test("newer overlapping evidence replaces the whole covered line, not only matching words", async () => {
        const { cache, input, lines } = fixture();
        await cache.publish(
            makeWordTimingArtifact({
                ...input,
                now: "2026-01-01T00:00:00Z",
                words: [
                    { text: "alpha", startSec: 0.1, endSec: 0.3 },
                    { text: "beta", startSec: 0.4, endSec: 0.6 },
                ],
            })
        );
        await cache.publish(
            makeWordTimingArtifact({
                ...input,
                window: { fromSec: 299, toSec: 302 },
                now: "2026-01-01T00:00:01Z",
                words: [{ text: "alpha", startSec: 2.2, endSec: 2.4 }],
            })
        );
        expect(cache.read(lines).entries[100].words?.map((word) => word.startSec)).toEqual([301.2]);
    });

    test("different raw timing evidence changes the revision even at the same generation time", async () => {
        const { cache, input, lines } = fixture();
        const first = makeWordTimingArtifact({ ...input, now: "2026-01-01T00:00:00Z" });
        await cache.publish(first);
        const revision = cache.read(lines).wordTimings.revision;
        const second = makeWordTimingArtifact({
            ...input,
            now: first.source.generatedAt,
            words: [{ text: "alpha", startSec: 0.6, endSec: 0.9 }],
        });
        await cache.publish(second);
        expect(cache.read(lines).wordTimings.revision).not.toBe(revision);
    });

    test("stale reads remove words even when the caller passes a previously enriched result", async () => {
        const { cache, input, lines, audio } = fixture();
        await cache.publish(makeWordTimingArtifact(input));
        const before = cache.read(lines).entries;
        expect(before[100].words).toHaveLength(1);
        writeFileSync(audio, "replaced-audio");
        const after = cache.read(before);
        expect(after.wordTimings.state).toBe("stale");
        expect(after.entries.every((line) => line.words === undefined)).toBe(true);
    });

    test("duplicate manifest entries do not repeat work or change the revision", async () => {
        const { cache, input, lines } = fixture();
        await cache.publish(makeWordTimingArtifact(input));
        const first = cache.read(lines);
        const key = wordTimingHash(input.window);
        writeFileSync(join(cache.folder, "index.json"), SafeJSON.stringify({ version: 1, windows: [key, key, key] }));
        const second = cache.read(lines);
        expect(second.wordTimings.windows).toHaveLength(1);
        expect(second.wordTimings.revision).toBe(first.wordTimings.revision);
        expect(second.entries).toEqual(first.entries);
    });

    test("the aggregate read budget refuses a bloated cache without partial word results", async () => {
        const { cache, input, lines } = fixture();
        await cache.publish(makeWordTimingArtifact(input));
        const keys: string[] = [];
        for (let index = 0; index < 9; index++) {
            const window = { fromSec: index * 3, toSec: index * 3 + 2 };
            const artifact = makeWordTimingArtifact({ ...input, window });
            const key = wordTimingHash(window);
            keys.push(key);
            writeFileSync(
                join(cache.folder, `${key}.json`),
                SafeJSON.stringify({ ...artifact, padding: "x".repeat(1024 * 1024) })
            );
        }
        writeFileSync(join(cache.folder, "index.json"), SafeJSON.stringify({ version: 1, windows: keys }));
        const read = cache.read(lines);
        expect(read.wordTimings.state).toBe("stale");
        expect(read.entries.every((line) => line.words === undefined)).toBe(true);
    });

    test("malformed cached bounds are ignored rather than breaking ordinary transcript reads", async () => {
        const { cache, input, lines } = fixture();
        const badWindow = { fromSec: 300, toSec: 330 },
            key = wordTimingHash(badWindow);
        await cache.publish(makeWordTimingArtifact(input));
        writeFileSync(
            join(cache.folder, `${key}.json`),
            SafeJSON.stringify({ ...makeWordTimingArtifact(input), window: badWindow })
        );
        writeFileSync(join(cache.folder, "index.json"), SafeJSON.stringify({ version: 1, windows: [key] }));
        expect(() => cache.read(lines)).not.toThrow();
        expect(cache.read(lines).wordTimings.state).toBe("stale");
        expect(cache.read(lines).entries.every((line) => line.words === undefined)).toBe(true);
    });
});
