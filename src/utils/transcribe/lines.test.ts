import { describe, expect, test } from "bun:test";
import { applyCorrections } from "./apply";
import { heardIn, TranscriptLines } from "./lines";
import type { TranscriptEntry } from "./types";

function line(speaker: string, startSec: number | undefined, text: string): TranscriptEntry {
    return { speaker, startSec, text };
}

describe("heard words", () => {
    test("match whole words only: Ada is not found inside zadání", () => {
        expect(heardIn("Tak to je zadání od Ady.", "Ada")).toEqual([]);
        expect(heardIn("Ada poslala zadání, a pak Ada odešla.", "Ada").map((found) => found.at)).toEqual([0, 26]);
    });

    test("match any case, Czech letters too, and any run of spaces, while diacritics stay as written", () => {
        expect(heardIn("ČEZ a  Účet", "čez")).toEqual([{ at: 0, text: "ČEZ" }]);
        expect(heardIn("ČEZ a  Účet", "a účet")).toEqual([{ at: 4, text: "a  Účet" }]);
        expect(heardIn("Ucet", "účet")).toEqual([]);
    });

    test("the n-th occurrence in a range, and the spot it is said at from its place in the line", () => {
        const lines = new TranscriptLines([
            line("Alice Example", 10, "Ada, zadání a Ada."),
            line("Bob Example", 20, "Ada."),
            line("Alice Example", 30, "Konec."),
        ]);
        const range = { heard: "ada", fromSec: 10, toSec: 20 };

        expect(lines.occurrences(range).map((found) => [found.index, found.at])).toEqual([
            [0, 0],
            [0, 14],
            [1, 0],
        ]);
        const late = lines.heardLine(range, 1)!;

        expect(lines.spotSec(late)).toBeCloseTo(10 + (14 / 18) * 10);
        // A late word is in its clip: the clip follows the spot, not the line's first seconds.
        const clip = lines.clip(late)!;

        expect(clip.fromSec).toBeLessThan(lines.spotSec(late)!);
        expect(clip.toSec).toBeGreaterThan(lines.spotSec(late)!);
        expect(lines.context(late, 80)).toMatchObject({ lead: "Ada, zadání a ", heard: "Ada", rest: "." });
    });
});

describe("the line at a time", () => {
    const entries = [
        line("Alice Example", 10, "První věta"),
        line("Speaker 5", 12, "dot"),
        line("Bob Example", 12, "áhnu to zítra."),
        line("Alice Example", 20, "Konec."),
    ];
    const lines = new TranscriptLines(entries);

    test("two lines in one second are reported, not guessed", () => {
        expect(lines.at(10)).toEqual({ kind: "found", index: 0 });
        expect(lines.at(12)).toEqual({ kind: "ambiguous", indexes: [1, 2] });
        expect(lines.at(15)).toEqual({ kind: "none" });
        expect(lines.at(12, (entry) => entry.text.includes("zítra"))).toEqual({ kind: "found", index: 2 });
    });

    test("an address names its line while that line still starts at its time", () => {
        expect(lines.resolve({ atSec: 12, line: 2 })).toEqual({ kind: "found", index: 2 });
        expect(lines.resolve({ atSec: 12, line: 0 })).toEqual({ kind: "ambiguous", indexes: [1, 2] });
    });

    test("one rule for the end: the next timed line's start, at least one second on; the last line five", () => {
        expect([0, 1, 2, 3].map((index) => lines.end(index))).toEqual([12, 13, 20, 25]);
    });
});

describe("corrections on two lines in one second", () => {
    const entries = [
        line("Alice Example", 10, "Tak to já dot"),
        line("Bob Example", 12, "Jasně."),
        line("Alice Example", 12, "áhnu zítra."),
        line("Bob Example", 20, "Ada a zadání."),
    ];

    test("a join finds the two halves of its word, also with another voice between them in one second", () => {
        const applied = applyCorrections(entries, {
            joins: [{ atSec: 12, joined: "dotáhnu", item: "i1" }],
        });

        expect(applied.entries.map((entry) => entry.text)).toEqual([
            "Tak to já dotáhnu",
            "Jasně.",
            "zítra.",
            "Ada a zadání.",
        ]);
    });

    test("a line fix with two candidate lines does not apply and says so; with an address it applies", () => {
        const twice = [line("A", 5, "To je Ada."), line("B", 5, "Ada ne.")];
        const guessed = applyCorrections(twice, {
            terms: [{ heard: "Ada", replacement: "ADA", atSec: 5, item: "i2" }],
        });

        expect(guessed.entries.map((entry) => entry.text)).toEqual(["To je Ada.", "Ada ne."]);
        expect(guessed.outcomes).toEqual([
            {
                item: "i2",
                status: "ambiguous",
                lines: [
                    { index: 0, startSec: 5 },
                    { index: 1, startSec: 5 },
                ],
                reason: '2 lines start at 00:05 with "Ada"',
            },
        ]);

        const anchored = applyCorrections(twice, {
            terms: [{ heard: "Ada", replacement: "ADA", atSec: 5, line: 1, item: "i2" }],
        });

        expect(anchored.entries.map((entry) => entry.text)).toEqual(["To je Ada.", "ADA ne."]);
        expect(anchored.outcomes[0]).toEqual({ item: "i2", status: "applied", lines: [{ index: 1, startSec: 5 }] });
    });

    test("a term fix never changes the word inside another word", () => {
        const applied = applyCorrections(entries, { terms: [{ heard: "Ada", replacement: "ADA", item: "i3" }] });

        expect(applied.entries[3]!.text).toBe("ADA a zadání.");
    });
});
