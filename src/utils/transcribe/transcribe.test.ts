import { describe, expect, test } from "bun:test";
import { applyDictionary, dictionaryLevelSchema, mergeDictionaries } from "./dictionary";
import { LEAVE_PHRASES, type Presence, speakerStats } from "./speakers";
import type { Participant, TranscriptEntry } from "./types";

function line(speaker: string, startSec: number | undefined, text: string, speakerId?: number): TranscriptEntry {
    return { speaker, startSec, text, speakerId };
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

    test("a label that says goodbye and speaks on later marks a boundary, strong when a language model named it", () => {
        const participants: Participant[] = [
            { speakerId: 1, name: "Alice Example", origin: "platform" },
            { speakerId: 2, name: "Carol Example", origin: "llm" },
        ];
        const stats = speakerStats(
            [
                line("Alice Example", 0, "Začneme.", 1),
                line("Carol Example", 10, "Hele, já už musím, mějte se.", 2),
                line("Alice Example", 20, "Díky.", 1),
                line("Carol Example", 80, "Tak já bych pokračoval s databází.", 2),
            ],
            { participants }
        );
        const carol = stats.speakers.find((s) => s.label === "Carol Example")!;

        expect(carol.origin).toBe("llm");
        expect(carol.leaves).toEqual([
            { atSec: 10, text: "Hele, já už musím, mějte se.", continuesAtSec: 80, confirmedBy: "Alice Example" },
        ]);
        expect(stats.hints).toContainEqual(
            expect.objectContaining({ kind: "leave-then-continues", label: "Carol Example", strength: "strong" })
        );
    });

    test("R13: a goodbye another label answers is a departure; one nobody answers is only an intention", () => {
        const stats = speakerStats([
            line("Carol Example", 0, "Já už musím jít.", 2),
            line("Alice Example", 4, "Jo, nic se neděje, čau.", 1),
            line("Alice Example", 100, "Teď vás přetahuju a musím jít.", 1),
            line("Bob Example", 140, "Ještě jedna věc.", 3),
            line("Carol Example", 160, "Pokračuju já.", 2),
            line("Alice Example", 200, "Dobře, tak končíme.", 1),
        ]);
        const leaves = (label: string) => stats.speakers.find((s) => s.label === label)!.leaves;

        expect(leaves("Carol Example")).toEqual([
            expect.objectContaining({ atSec: 0, confirmedBy: "Alice Example", continuesAtSec: 160 }),
        ]);
        // Alice's "čau" answers Carol's goodbye: it is not Alice leaving.
        expect(leaves("Alice Example").map((leave) => leave.atSec)).toEqual([100]);
        expect(leaves("Alice Example")[0]!.confirmedBy).toBeUndefined();
        expect(stats.hints).toContainEqual(
            expect.objectContaining({ kind: "leave-then-continues", label: "Alice Example", strength: "weak" })
        );
    });

    test("R14: a 'taky' goodbye right after another label's goodbye names that label as someone else", () => {
        const stats = speakerStats([
            line("Alice Example", 0, "Já už musím jít.", 1),
            line("Carol Example", 3, "Já se taky omlouvám, už musím jít.", 2),
            line("Alice Example", 60, "Tak ještě shrnu.", 1),
            line("Carol Example", 90, "A já dodám jednu věc.", 2),
        ]);
        const carol = stats.speakers.find((s) => s.label === "Carol Example")!;

        expect(carol.leaves[0]!.echoOf).toEqual({ label: "Alice Example", atSec: 0 });
    });

    test("RA: a label speaking while its person is out of the call, and a voice when one person is left", () => {
        const presence: Presence[] = [
            { name: "alice@example.com", self: true, fromSec: 0, toSec: 400 },
            { name: "Example Carol (QT)", fromSec: 100, toSec: 300 },
            { name: "Bob Example", fromSec: 0, toSec: 350 },
        ];
        const stats = speakerStats(
            [
                line("Carol Example", 20, "Ahoj, jsem tu?", 2),
                line("Bob Example", 50, "Začneme.", 3),
                line("Carol Example", 150, "Teď už tu jsem.", 2),
                line("Bob Example", 200, "Dobře.", 3),
                line("Carol Example", 380, "A ještě jedna věc.", 2),
            ],
            { presence }
        );

        expect(stats.hints[0]).toEqual({
            kind: "absent-speaker",
            label: "Carol Example",
            strength: "strong",
            ranges: [
                { fromSec: 20, toSec: 20, lines: 1 },
                { fromSec: 380, toSec: 380, lines: 1 },
            ],
        });
        expect(stats.hints).toContainEqual(
            expect.objectContaining({
                kind: "sole-attendee",
                label: "Carol Example",
                person: "alice@example.com",
                self: true,
            })
        );
        expect(stats.hints.some((h) => h.label === "Bob Example" && h.kind === "absent-speaker")).toBe(false);
    });

    test("leave phrases match whole Czech words only", () => {
        const leaves = (text: string) => LEAVE_PHRASES.some((phrase) => phrase.test(text));

        expect(leaves("Dobrý, hele, mizím.")).toBe(true);
        expect(leaves("já už jsem měl před půl hodinou jít")).toBe(true);
        expect(leaves("nemizím")).toBe(false);
    });

    test("a split voice that cut a word prints the joined word", () => {
        const { hints } = speakerStats(meeting);
        const split = hints.find((h) => h.kind === "split-voice");

        expect(split).toMatchObject({ strength: "strong", join: { left: "dot", right: "áhnu", joined: "dotáhnu" } });
    });
});

describe("dictionary", () => {
    const mop = { type: "abbr", value: "MOP", substitution: "MOP (Obchodní partner podnikatel)" } as const;

    test("an abbreviation's substitution must contain the abbreviation, and the error names the entry", () => {
        const bad = dictionaryLevelSchema.safeParse({
            entries: [mop, { type: "abbr", value: "MOO", substitution: "Moje Obchodní Oddělení" }],
        });

        expect(bad.success).toBe(false);
        expect(bad.error?.issues[0]?.path).toEqual(["entries", 1, "substitution"]);
        expect(bad.error?.issues[0]?.message).toContain('"MOO (Moje Obchodní Oddělení)"');
        expect(dictionaryLevelSchema.safeParse({ entries: [mop] }).success).toBe(true);
    });

    test("a later level wins for its value and its expansion setting", () => {
        const merged = mergeDictionaries([
            { abbrExpansion: "every", entries: [mop, { type: "fix", value: "UVČ", substitution: "UI" }] },
            { abbrExpansion: "first", entries: [{ type: "fix", value: "UVČ", substitution: "UIčko" }] },
            undefined,
        ]);

        expect(merged.abbrExpansion).toBe("first");
        expect(merged.entries).toContainEqual({ type: "fix", value: "UVČ", substitution: "UIčko" });
        expect(merged.entries).toHaveLength(2);
    });

    const lines = [
        line("Alice Example", 0, "MOP má nové UVČ."),
        line("Bob Example", 5, "Ano, MOP (Obchodní partner podnikatel) i MOPy."),
        line("Alice Example", 9, "Tak MOP dořešíme."),
    ];
    const fix = { type: "fix", value: "UVČ", substitution: "UIčko" } as const;

    test("every mention: each whole-word MOP is expanded once, a written-out one and MOPy are left alone", () => {
        const applied = applyDictionary(lines, { abbrExpansion: "every", entries: [mop, fix] });

        expect(applied.entries.map((e) => e.text)).toEqual([
            "MOP (Obchodní partner podnikatel) má nové UIčko.",
            "Ano, MOP (Obchodní partner podnikatel) i MOPy.",
            "Tak MOP (Obchodní partner podnikatel) dořešíme.",
        ]);
        expect(applied).toMatchObject({ fixes: 1, expansions: 2 });
    });

    test("first mention only, and off", () => {
        const first = applyDictionary(lines, { abbrExpansion: "first", entries: [mop] });
        const off = applyDictionary(lines, { abbrExpansion: "off", entries: [mop] });

        expect(first.entries.map((e) => e.text)[2]).toBe("Tak MOP dořešíme.");
        expect(first.expansions).toBe(1);
        expect(off.entries).toEqual(lines);
    });
});
