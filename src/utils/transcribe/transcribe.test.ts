import { describe, expect, test } from "bun:test";
import { applyCorrections } from "./apply";
import { applyDictionary, dictionaryLevelSchema, fuzzyMatches, mergeDictionaries } from "./dictionary";
import { labelIdentityTable, lineEvidence, SELF } from "./evidence";
import { importanceOf } from "./importance";
import { stemOf } from "./languages/cs";
import { formatClock, parseClock } from "./render";
import { LEAVE_PHRASES, type Presence, presenceSections, speakerStats } from "./speakers";
import { citesPoint, keyWords, summaryPoints } from "./summary";
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
                { fromSec: 20, toSec: 20, lines: 1, present: ["Bob Example", "alice@example.com"] },
                { fromSec: 380, toSec: 380, lines: 1, present: ["alice@example.com"] },
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

    test("R15: an attendee silent under their own label for 15 minutes is a drift hint", () => {
        const stats = speakerStats(
            [
                line("Alice Example", 10, "Začneme."),
                line("Bob Example", 60, "Ano."),
                line("Bob Example", 1500, "Ještě já."),
            ],
            {
                presence: [
                    { name: "Alice Example", fromSec: 0, toSec: 2000 },
                    { name: "Bob Example", fromSec: 0, toSec: 1600 },
                    { name: "me@example.com", self: true, fromSec: 0, toSec: 2000 },
                ],
            }
        );
        const drift = stats.hints.filter((hint) => hint.kind === "label-drift");

        expect(drift).toEqual([
            expect.objectContaining({ person: "Alice Example", fromSec: 10, toSec: 2000 }),
            expect.objectContaining({ person: "Bob Example", fromSec: 60, toSec: 1500 }),
        ]);
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

describe("applyCorrections", () => {
    const lines = [
        line("Alice Example", 0, "Začneme s UVČ."),
        line("Speaker 5", 20, "jak já vlastně dot"),
        line("Carol Example", 21, "áhnu tu druhou queryu."),
        line("Carol Example", 60, "A MOP je hotový."),
        line("Carol Example", 200, "Pak ještě něco."),
    ];

    test("joins, ranges, renames, terms and the dictionary apply in that order", () => {
        const applied = applyCorrections(lines, {
            joins: [{ atSec: 21, speaker: "Carol Example" }],
            ranges: [{ label: "Carol Example", fromSec: 50, toSec: 100, speaker: "Bob Example" }],
            labels: { "Carol Example": "Carol Renamed" },
            terms: [{ heard: "UVČ", replacement: "UIčko" }],
            dictionary: {
                abbrExpansion: "every",
                entries: [{ type: "abbr", value: "MOP", substitution: "MOP (Obchodní partner)" }],
            },
        });

        expect(applied.entries.map((e) => [e.speaker, e.text])).toEqual([
            ["Alice Example", "Začneme s UIčko."],
            ["Carol Renamed", "jak já vlastně dotáhnu"],
            ["Carol Renamed", "tu druhou queryu."],
            ["Bob Example", "A MOP (Obchodní partner) je hotový."],
            ["Carol Renamed", "Pak ještě něco."],
        ]);
        expect(applied).toMatchObject({ joins: 1, ranges: 1, terms: 1, expansions: 1 });
    });

    test("a range matches the label a line came with, so a line moved to a name that is also a label stays", () => {
        const spoken = [line("Speaker 2", 10, "Jedna."), line("Alice Example", 12, "Dvě.")];
        const applied = applyCorrections(spoken, {
            ranges: [
                { label: "Speaker 2", fromSec: 0, toSec: 20, speaker: "Alice Example" },
                { label: "Alice Example", fromSec: 0, toSec: 20, speaker: "Bob Example" },
            ],
        });

        expect(applied.entries.map((e) => e.speaker)).toEqual(["Alice Example", "Bob Example"]);
    });

    test("a quote replaces the words it reads with the document text, untouched by the dictionary; a meaning follows its words", () => {
        const spoken = [
            line("Alice Example", 5, "Tak čtu: kapitola dva sekce UVČ, konec."),
            line("Bob", 9, "To je lomeno type."),
        ];
        const marks = [
            {
                atSec: 5,
                heard: "kapitola dva sekce UVČ",
                quote: { text: "Kap. 2, sekce `UVČ`.", source: "čte z Notes, ř. 4" },
            },
            { atSec: 9, heard: "lomeno type", meaning: "/{type}" },
        ];
        const dictionary = {
            abbrExpansion: "first" as const,
            entries: [{ type: "fix" as const, value: "UVČ", substitution: "UIčko" }],
        };
        const md = applyCorrections(spoken, { marks, dictionary, notes: "sup" });
        const txt = applyCorrections(spoken, { marks, dictionary });

        expect(md.entries.map((e) => e.text)).toEqual([
            "Tak čtu: \n\n> Kap. 2, sekce `UVČ`. <sup>(čte z Notes, ř. 4)</sup>\n\n, konec.",
            "To je lomeno type <sup>(`/{type}`)</sup>.",
        ]);
        expect(txt.entries.map((e) => e.text)).toEqual([
            "Tak čtu: „Kap. 2, sekce `UVČ`.“ (čte z Notes, ř. 4), konec.",
            "To je lomeno type (/{type}).",
        ]);
        expect(md.marks).toBe(2);
    });
});

describe("lineEvidence", () => {
    const entries = [
        line("Alice Example", 0, "Ahoj všichni."),
        line("Bob Example", 10, "Já mám otázku."),
        line("Bob Example", 20, "Jedna věc."),
        line("Bob Example", 30, "Konec."),
    ];
    const segments = [
        { startSec: 0, endSec: 10, channel: "system" as const, liveName: "Alice Example" },
        { startSec: 10, endSec: 20, channel: "mic" as const },
        { startSec: 20, endSec: 25, channel: "mic" as const },
        { startSec: 25, endSec: 30, channel: "system" as const, liveName: "Carol Example" },
    ];
    const speaking = [
        { tSec: 2, speaking: ["Alice Example"], muted: [] },
        { tSec: 22, speaking: ["Carol Example"], muted: ["Alice Example"] },
    ];

    test("the channel with the most overlap wins; an exact tie has no winner", () => {
        const lines = lineEvidence(entries, { segments, speaking });

        expect(lines[0]).toMatchObject({ winner: "Alice Example", micShare: 0, liveName: "Alice Example" });
        expect(lines[1]).toMatchObject({ winner: SELF, micShare: 1 });
        expect(lines[2]).toMatchObject({ tie: true, micShare: 0.5 });
        expect(lines[2]!.winner).toBeUndefined();
        expect(lines[3]!.micShare).toBeUndefined();
        // The reading during the line (Carol) and the state at its start (Alice, shown since second 2).
        expect(lines[2]!.speaking).toEqual({ "Alice Example": 1, "Carol Example": 1 });
    });

    test("the label-by-voice table counts ties and lines without evidence apart", () => {
        const table = labelIdentityTable(lineEvidence(entries, { segments, speaking }));

        expect(Object.fromEntries(table.get("Bob Example")!)).toEqual({ [SELF]: 1, tie: 1, "?": 1 });
    });
});

describe("parseClock", () => {
    test("reads h:mm:ss, mm:ss and seconds, and refuses anything else", () => {
        expect(parseClock("1:23:50")).toBe(5030);
        expect(parseClock("23:50")).toBe(1430);
        expect(parseClock("90")).toBe(90);
        expect(parseClock("1:2:3:4")).toBeUndefined();
        expect(parseClock("soon")).toBeUndefined();
        expect(parseClock(formatClock(5030))).toBe(5030);
    });
});

describe("lineEvidence fields (R2.1, R2.2)", () => {
    test("each line carries its refined id, the winning voice id, the echo score and the energy share", () => {
        const [first] = lineEvidence(
            [{ speaker: "Bob Example", speakerId: 4, startSec: 0, text: "Pošlu to zítra." }],
            {
                segments: [
                    { startSec: 0, endSec: 4, channel: "mic", voiceId: 1, text: "Pošlu to zítra." },
                    {
                        startSec: 0,
                        endSec: 1,
                        channel: "system",
                        voiceId: 1002,
                        liveName: "Bob Example",
                        text: "pošlu to zítra",
                    },
                ],
                speaking: [],
            },
            undefined,
            () => 0.8
        );

        expect(first).toMatchObject({ refinedSpeakerId: 4, liveVoiceId: 1, energyMic: 0.8, winner: SELF });
        expect(first!.echo).toBe(1);
    });
});

describe("presenceSections (R2.4)", () => {
    test("one section per join or leave; someone who comes back is present again", () => {
        const sections = presenceSections([
            { name: "Alice Example", fromSec: 0, toSec: 300 },
            { name: "Bob Example", fromSec: 60, toSec: 120 },
            { name: "Bob Example", fromSec: 200, toSec: 300 },
        ]);

        expect(sections).toEqual([
            { fromSec: 0, toSec: 60, present: ["Alice Example"] },
            { fromSec: 60, toSec: 120, present: ["Alice Example", "Bob Example"] },
            { fromSec: 120, toSec: 200, present: ["Alice Example"] },
            { fromSec: 200, toSec: 300, present: ["Alice Example", "Bob Example"] },
        ]);
    });
});

describe("spoken forms and fuzzy matches (R2.5)", () => {
    const dictionary = mergeDictionaries([
        {
            fuzzy: { apply: 0.95, suggest: 0.8 },
            entries: [
                { type: "term", value: "JDZ", spoken: ["jenezetka", "jenezetkou"] },
                { type: "term", value: "Kubernetes" },
            ],
        },
    ]);

    test("Czech endings are stripped before a comparison", () => {
        expect(["jenezetka", "jenezetkou", "jenezetkama", "Kubernetesu"].map(stemOf)).toEqual([
            "jenezet",
            "jenezet",
            "jenezet",
            "kubernetes",
        ]);
    });

    test("a spoken form is replaced; a close word at or above apply too; a weaker one is only a match", () => {
        const entries = [line("Alice Example", 0, "Ta Jenezetkou se pošle, jenezetkama taky, a kubernetu ne.")];
        const matches = fuzzyMatches(entries, dictionary);
        const applied = applyDictionary(entries, dictionary);

        expect(matches).toContainEqual(expect.objectContaining({ heard: "jenezetkama", value: "JDZ", score: 1 }));
        expect(matches).toContainEqual(expect.objectContaining({ heard: "kubernetu", value: "Kubernetes" }));
        expect(matches.find((match) => match.heard === "kubernetu")!.score).toBeLessThan(0.95);
        expect(applied.entries[0]!.text).toBe("Ta JDZ se pošle, JDZ taky, a kubernetu ne.");
        expect(applied).toMatchObject({ spoken: 1, fuzzy: 1 });
    });
});

describe("notes and unclear passages (R2.6, R2.7)", () => {
    const lines: TranscriptEntry[] = [
        { speaker: "Speaker 5", startSec: 0, text: "MOP a JDZ jsou hotové." },
        { speaker: "Speaker 5", startSec: 5, text: "JDZ ještě projdeme, MOP taky." },
        { speaker: "Alice Example", startSec: 9, text: "A ten pentagon?" },
    ];
    const dictionary = mergeDictionaries([
        {
            abbrExpansion: "first",
            entries: [
                { type: "abbr", value: "MOP", substitution: "MOP (Obchodní partner)" },
                { type: "term", value: "JDZ", meaning: "jednotný dodací závazek" },
            ],
        },
    ]);

    test("Markdown writes the expansion and a term's meaning as a superscript, at the first mention", () => {
        const applied = applyDictionary(lines, dictionary, { notes: "sup" });
        expect(applied.entries.map((line) => line.text)).toEqual([
            "MOP <sup>(Obchodní partner)</sup> a JDZ <sup>(jednotný dodací závazek)</sup> jsou hotové.",
            "JDZ ještě projdeme, MOP taky.",
            "A ten pentagon?",
        ]);
        expect(applied.meanings).toBe(1);
    });

    test("text keeps the stored form in parentheses", () => {
        expect(applyDictionary(lines, dictionary).entries[0]!.text).toBe(
            "MOP (Obchodní partner) a JDZ (jednotný dodací závazek) jsou hotové."
        );
    });

    test("an open speaker question replaces the label; open words are marked with their readings", () => {
        const applied = applyCorrections(lines, {
            labels: { "Speaker 5": "Carol Example" },
            unclear: {
                label: "nejasné",
                passages: [
                    { fromSec: 0, toSec: 0, speaker: "Speaker 5", readings: ["Alice Example", "Bob Example"] },
                    { fromSec: 9, toSec: 12, heard: "pentagon", readings: ["Pentaho"] },
                ],
            },
        });
        expect(applied.entries.map((line) => [line.speaker, line.text])).toEqual([
            ['[nejasné: "Speaker 5"; 1) Alice Example 2) Bob Example]', "MOP a JDZ jsou hotové."],
            ["Carol Example", "JDZ ještě projdeme, MOP taky."],
            ["Alice Example", 'A ten [nejasné: "pentagon"; 1) Pentaho]?'],
        ]);
        expect(applied.unclear).toBe(2);
    });
});

describe("summary points and importance", () => {
    test("action items and decisions come from their headings, with the owner in parentheses", () => {
        const markdown = [
            "### Shrnutí",
            "- Probrali jsme export.",
            "### Další kroky",
            "- (Bob Example) Připravit export dat do nového systému (3. 11.)",
            "### Přijatá rozhodnutí",
            "- Export poběží každou noc.",
        ].join("\n");
        const points = summaryPoints(markdown, {
            actionHeadings: ["Další kroky"],
            decisionHeadings: ["Přijatá rozhodnutí"],
        });
        expect(points.map((point) => [point.kind, point.person ?? ""])).toEqual([
            ["action", "Bob Example"],
            ["decision", ""],
        ]);
        expect(citesPoint(new Set(keyWords("ten export dat do nového systému připravíme")), points[0]!)).toBe(true);
        expect(citesPoint(new Set(keyWords("dobrý den všem")), points[0]!)).toBe(false);
    });

    test("fillers carry nothing; a decision word makes a short line matter", () => {
        expect(importanceOf("Jo, jo, mhm.")).toEqual({ words: 3, fillersOnly: true, decision: false });
        expect(importanceOf("Tak to pošlu zítra.").decision).toBe(true);
    });
});

describe("mute state", () => {
    test("a reading that did not read the mute state does not clear it; a read one 10 s back still holds", () => {
        const [line] = lineEvidence([{ speaker: "Bob Example", startSec: 20, text: "Čus." }], {
            segments: [{ startSec: 20, endSec: 22, channel: "system" }],
            speaking: [
                { tSec: 17.8, speaking: ["Carol Example"], muted: ["Alice Example"] },
                { tSec: 20.7, speaking: ["Bob Example"] },
            ],
        });
        expect(line?.muted).toEqual(["Alice Example"]);

        const [stale] = lineEvidence([{ speaker: "Bob Example", startSec: 40, text: "Čus." }], {
            segments: [{ startSec: 40, endSec: 42, channel: "system" }],
            speaking: [{ tSec: 17.8, speaking: [], muted: ["Alice Example"] }],
        });
        expect(stale?.muted).toBeUndefined();
    });
});
