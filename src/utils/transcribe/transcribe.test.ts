import { describe, expect, test } from "bun:test";
import { speakerStats } from "./speakers";
import type { TranscriptEntry } from "./types";

function line(speaker: string, startSec: number | undefined, text: string): TranscriptEntry {
    return { speaker, startSec, text };
}

describe("speakerStats", () => {
    // The two shapes of a real meeting: one label holding several voices far apart, and one short label that cut a
    // word off its neighbour ("dot" | "áhnu").
    const meeting = [
        line("Alice Example", 0, "Dobrý den, začneme wiki."),
        line("Bob Example", 10, "Ano, mám otázku k zadání."),
        line("Alice Example", 20, "Tak se na to podíváme"),
        line("Speaker 5", 24, "dot"),
        line("Alice Example", 25, "áhnu to ze zadání a pošlu."),
        line("Bob Example", 40, "Díky, mějte se."),
        line("Alice Example", 600, "Teď mluví někdo jiný pod stejným jménem a dlouho vysvětluje změny ve wiki."),
        line("Alice Example", 660, "A pokračuje s dalším bodem."),
    ];

    test("counts turns, lines, words and spans per label", () => {
        const stats = speakerStats(meeting);
        const alice = stats.speakers.find((s) => s.label === "Alice Example")!;

        expect(stats.timed).toBe(true);
        expect(alice.turns).toBe(4);
        expect(alice.lines).toBe(5);
        expect(alice.words).toBe(33);
        expect(alice.spans.map((s) => [s.fromSec, s.turns])).toEqual([
            [0, 3],
            [600, 1],
        ]);
    });

    test("hints at a label that is several people and at a lone label next to another", () => {
        const { hints } = speakerStats(meeting);

        expect(hints).toContainEqual(
            expect.objectContaining({ kind: "several-people", label: "Alice Example", spans: 2 })
        );
        expect(hints).toContainEqual(
            expect.objectContaining({ kind: "split-voice", label: "Speaker 5", neighbour: "Alice Example", atSec: 24 })
        );
        expect(hints.some((h) => h.label === "Bob Example")).toBe(false);
    });

    test("a transcript without times gives counts only and no time-based hint", () => {
        const stats = speakerStats(meeting.map((entry) => ({ ...entry, startSec: undefined })));

        expect(stats.timed).toBe(false);
        expect(stats.speakers.every((s) => s.spokenSec === 0 && s.spans.length === 0)).toBe(true);
        expect(stats.hints.some((h) => h.kind === "several-people")).toBe(false);
    });
});
