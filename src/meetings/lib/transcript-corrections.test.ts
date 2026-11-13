import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { meetingItemSchema, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { applyCorrections } from "@genesiscz/utils/transcribe/apply";
import { groupTurns, transcriptMarkdown, transcriptTextLines } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { prepareFindings } from "./add-findings";
import { findingSchema } from "./findings";
import { answerQuestion } from "./questions";
import { composedMeeting } from "./sources";
import { checkAnchors, correctionsOf, correctTranscript, ledgerEntryFor, outcomeText } from "./transcript-corrections";

function line(speaker: string, startSec: number, text: string): TranscriptEntry {
    return { speaker, startSec, text };
}

const base = meetingRecordSchema.parse({
    id: "2026-11-02_15-00-planning",
    title: "Planning",
    start: "2026-11-02T15:00:00.000Z",
    createdAt: "2026-11-02T15:00:00.000Z",
    createdBy: "new",
    project: "demo",
});
const config = meetingsConfigSchema.parse({});
const item = (fields: Record<string, unknown>) =>
    meetingItemSchema.parse({
        status: "confirmed",
        suggestedAt: "2026-11-02T15:00:00.000Z",
        rules: [MeetingRule.Agent],
        ...fields,
    });
const transcript = [
    line("Speaker 5", 0, "Jak to dot"),
    line("Carol Example", 10, "áhnu do konce."),
    line("Carol Example", 20, "Pošlu to Adě, je to v zadání."),
    line("Speaker 2", 30, "Otevři offers section."),
];

describe("the corrections pipeline", () => {
    test("a source label in decomposed form matches the composed label the CLI stores, once the source composes it", () => {
        const label = "Zoë Example";
        const source: SourceMeeting = {
            sourceMeetingId: "w1",
            title: "Planning",
            start: "2026-11-02T15:00:00.000Z",
            participants: [{ name: label.normalize("NFD"), from: ["wisprflow"] }],
            speakers: [{ speakerId: 1, name: label.normalize("NFD"), origin: "platform" }],
            transcript: [line(label.normalize("NFD"), 0, "Ahoj."), line(label.normalize("NFD"), 10, "Jak se máš?")],
            folders: [],
        };
        const record = meetingRecordSchema.parse({
            ...base,
            items: [item({ id: "i1", kind: "speaker-range", label, fromSec: 0, toSec: 10, speaker: "Carol Example" })],
        });
        const correct = (meeting: SourceMeeting) =>
            correctTranscript({ record, transcript: meeting.transcript, config, format: "md", dictionary: false });
        const composed = composedMeeting(source);

        expect(correct(source).outcomes).toContainEqual(expect.objectContaining({ item: "i1", status: "not-found" }));
        expect(correct(composed).entries.map((entry) => entry.speaker)).toEqual(["Carol Example", "Carol Example"]);
        expect(composed.speakers[0]?.name).toBe(label);
        expect(composed.participants[0]?.name).toBe(label);
    });

    test.each([
        ["Speaker 5", 0, "Alice Example", "Carol Example"],
        ["Carol Example", 10, "Alice Example", "Alice Example"],
    ])("an explicit assignment of %s survives a join", (label, atSec, person, remainder) => {
        const record = meetingRecordSchema.parse({
            ...base,
            speakers: {
                ...base.speakers,
                assignments: [
                    { id: "a1", label, fromSec: atSec, toSec: atSec, person, at: "2026-11-03T10:00:00.000Z" },
                ],
            },
            items: [item({ id: "i1", kind: "join", atSec: 10, joined: "dotáhnu", speaker: "Join voice" })],
        });
        const result = correctTranscript({
            record,
            transcript: transcript.slice(0, 2),
            config,
            format: "md",
            dictionary: false,
        });
        expect(result.entries[0]).toMatchObject({ text: "Jak to dotáhnu", speaker: person });
        expect(result.entries[1]).toMatchObject({ text: "do konce.", speaker: remainder });
    });

    test("a chained join keeps every source address and the latest explicit assignment wins", () => {
        const named = (withLater: boolean) =>
            meetingRecordSchema.parse({
                ...base,
                speakers: {
                    ...base.speakers,
                    assignments: [
                        ...(withLater
                            ? [
                                  {
                                      id: "a2",
                                      label: "C",
                                      fromSec: 10,
                                      toSec: 10,
                                      person: "Later Example",
                                      at: "2026-11-04T10:00:00.000Z",
                                  },
                              ]
                            : []),
                        {
                            id: "a1",
                            label: "B",
                            fromSec: 5,
                            toSec: 5,
                            person: "Earlier Example",
                            at: "2026-11-03T10:00:00.000Z",
                        },
                    ],
                },
                items: [
                    item({ id: "i1", kind: "join", atSec: 5, joined: "One two", speaker: "B" }),
                    item({ id: "i2", kind: "join", atSec: 10, joined: "two three", speaker: "C" }),
                ],
            });
        const words = [line("A", 0, "One"), line("B", 5, "two"), line("C", 10, "three")];
        for (const withLater of [false, true]) {
            const result = correctTranscript({
                record: named(withLater),
                transcript: words,
                config,
                format: "md",
                dictionary: false,
            });
            expect(result.entries).toEqual([
                { startSec: 0, text: "One two three", speaker: withLater ? "Later Example" : "Earlier Example" },
            ]);
        }
    });

    test("a speaker answered in decomposed form (from the window) is one speaker with the composed one", () => {
        const composed = "Zoë Example";
        const decomposed = composed.normalize("NFD");
        const record = meetingRecordSchema.parse({
            ...base,
            participants: [{ name: composed, from: ["wisprflow"] }],
            items: [
                item({
                    id: "i1",
                    kind: "speaker-range",
                    label: "Carol Example",
                    fromSec: 15,
                    toSec: 25,
                    speaker: decomposed,
                }),
            ],
        });
        const named = [line(composed, 0, "Ahoj."), ...transcript.slice(1)];
        const result = correctTranscript({ record, transcript: named, config, format: "md", dictionary: false });

        expect(decomposed).not.toBe(composed);
        expect(result.speakers.filter((speaker) => speaker.name === composed)).toEqual([{ name: composed, lines: 2 }]);
        expect(result.entries.every((entry) => entry.speaker === entry.speaker.normalize("NFC"))).toBe(true);
    });

    test("gives an outcome per item: applied to its lines, not found, or shadowed by another item", () => {
        const record = meetingRecordSchema.parse({
            ...base,
            items: [
                item({ id: "i1", kind: "join", atSec: 10, joined: "dotáhnu", speaker: "Carol Example" }),
                item({
                    id: "i2",
                    kind: "speaker-range",
                    label: "Carol Example",
                    fromSec: 15,
                    toSec: 25,
                    speaker: "Alice Example",
                }),
                item({ id: "i3", kind: "term", heard: "Ada", proposed: "ADA", atSec: 20 }),
                item({ id: "i4", kind: "term", heard: "offers section", proposed: "OffersSection", atSec: 30 }),
                item({ id: "i5", kind: "term", heard: "offers", proposed: "Offers", atSec: 30 }),
                item({ id: "i6", kind: "term", heard: "Adě", meaning: "`ADA`", atSec: 20 }),
            ],
        });
        const result = correctTranscript({ record, transcript, config, format: "md", dictionary: false });
        const byItem = new Map(result.outcomes.map((outcome) => [outcome.item, outcome]));

        expect(byItem.get("i1")).toMatchObject({ status: "applied" });
        expect(byItem.get("i2")).toEqual({ item: "i2", status: "applied", lines: [{ index: 2, startSec: 20 }] });
        // "Ada" is a whole word nowhere: "zadání" holds the letters, and "Adě" is another word.
        expect(outcomeText(byItem.get("i3")!)).toBe('i3 did not apply: no "Ada"');
        expect(byItem.get("i5")).toMatchObject({ status: "shadowed", by: "i4" });
        expect(outcomeText(byItem.get("i5")!)).toBe('i5 did not apply: i4 changed "offers" first');
        // A meaning written with its own backticks is wrapped once.
        expect(result.entries[2]!.text).toBe("Pošlu to Adě <sup>(`ADA`)</sup>, je to v zadání.");
    });

    test("lists the people after the corrections with their line counts, apart from labels nobody named", () => {
        const record = meetingRecordSchema.parse({
            ...base,
            participants: [{ name: "Carol Example" }],
            items: [
                item({
                    id: "i1",
                    kind: "speaker-range",
                    label: "Carol Example",
                    fromSec: 15,
                    toSec: 25,
                    speaker: "Alice Example",
                }),
            ],
        });
        const result = correctTranscript({ record, transcript, config, format: "md", dictionary: false });

        expect(result.speakers).toEqual([
            { name: "Alice Example", lines: 1 },
            { name: "Carol Example", lines: 1 },
        ]);
        expect(result.unattributed).toEqual([
            { name: "Speaker 2", lines: 1 },
            { name: "Speaker 5", lines: 1 },
        ]);
    });

    test("an open speaker mark matches the line's source label, not the speaker a range already gave it", () => {
        const applied = applyCorrections([line("Speaker 2", 10, "Jedna."), line("Alice Example", 12, "Dvě.")], {
            ranges: [{ label: "Speaker 2", fromSec: 0, toSec: 20, speaker: "Alice Example" }],
            unclear: {
                label: "nejasné",
                passages: [{ fromSec: 0, toSec: 20, speaker: "Alice Example", readings: ["Bob"] }],
            },
        });

        expect(applied.entries.map((entry) => entry.speaker)).toEqual([
            "Alice Example",
            '[nejasné: "Alice Example"; 1) Bob]',
        ]);
    });
});

describe("the corrections ledger", () => {
    test("a confirmed term and a confirmed join each write their entry; a join answered through a question too", () => {
        const term = item({ id: "i1", kind: "term", heard: "redakt", proposed: "Redux", atSec: 5 });
        const join = item({
            id: "i2",
            kind: "join",
            atSec: 10,
            joined: "dotáhnu",
            speaker: "Carol Example",
            evidence: { left: "dot", right: "áhnu" },
        });
        const now = "2026-11-02T16:00:00.000Z";

        expect(ledgerEntryFor(base, term, now)).toEqual({
            at: now,
            meeting: base.id,
            project: "demo",
            kind: "term",
            scope: "everywhere",
            heard: "redakt",
            fixed: "Redux",
            item: "i1",
        });
        const lineOnly = item({ id: "i3", kind: "term", heard: "redakt", proposed: "Redux", atSec: 5, scope: "line" });
        expect(ledgerEntryFor(base, lineOnly, now)?.scope).toBe("line");
        expect(ledgerEntryFor(base, join, now)).toEqual({
            at: now,
            meeting: base.id,
            project: "demo",
            kind: "join",
            heard: "dot áhnu",
            fixed: "dotáhnu",
            item: "i2",
        });
        expect(ledgerEntryFor(base, { ...join, status: "suggested" }, now)).toBeUndefined();
    });
});

describe("anchors at items add", () => {
    test("an item at a second two lines start in is warned about; one line gets its address", () => {
        const twice = [line("A", 5, "To je Ada."), line("B", 5, "Ada ne."), line("A", 9, "Konec.")];
        const { warnings, addresses } = checkAnchors(
            [
                item({ id: "i1", kind: "term", heard: "Ada", proposed: "ADA", atSec: 5, scope: "line" }),
                item({ id: "i2", kind: "term", heard: "Konec", proposed: "Konec!", atSec: 9, scope: "line" }),
                item({ id: "i3", kind: "join", atSec: 40, joined: "dotáhnu" }),
            ],
            twice
        );

        expect(warnings).toEqual([
            'i1: 2 lines start at 00:05 (line 0 "To je Ada.", line 1 "Ada ne."); it will not apply until its finding names one with "line": <n>',
            "i3: no line starts at 00:40",
        ]);
        expect([...addresses]).toEqual([["i2", 2]]);
    });

    test("findings added through the shared preparation get the same anchors, and a refused finding throws", () => {
        const twice = [line("A", 5, "To je Ada."), line("B", 5, "Ada ne."), line("A", 9, "Konec.")];
        const findings = z.array(findingSchema).parse([
            {
                kind: "term",
                at: 9,
                heard: "Konec",
                proposed: "Konec!",
                scope: "line",
                confidence: 0.9,
                reason: "heard",
            },
            { kind: "term", at: 5, heard: "Ada", proposed: "ADA", scope: "line", confidence: 0.9, reason: "heard" },
        ]);
        expect(() => prepareFindings({ findings, items: [], transcript: twice })).toThrow("choose a line");
        const { added, warnings } = prepareFindings({ findings, items: [], transcript: twice, force: true });

        expect(added.map((one) => one.evidence?.transcriptLine)).toEqual([2, undefined]);
        expect(warnings).toHaveLength(1);
        expect(prepareFindings({ findings, items: [] }).warnings).toEqual([]);
        const twiceNamed = z.array(findingSchema).parse([
            { kind: "term", ref: "a", at: 9, heard: "Konec", confidence: 0.9, reason: "heard" },
            { kind: "term", ref: "a", at: 5, heard: "Ada", confidence: 0.9, reason: "heard" },
        ]);
        expect(() => prepareFindings({ findings: twiceNamed, items: [] })).toThrow(
            'ref "a" names more than one finding'
        );
    });
});

describe("a label that tracks no one person", () => {
    const mixed = [
        line("Speaker 5", 0, "Začneme."),
        line("Speaker 5", 10, "Já jsem to upravil."),
        line("Speaker 5", 20, "Dobře, další bod."),
        line("Speaker 5", 90, "Ještě jedna věc."),
    ];
    const label = item({
        id: "i1",
        kind: "label",
        label: "Speaker 5",
        fromSec: 0,
        toSec: 30,
        meaningless: true,
        status: "suggested",
        evidence: { reason: "two voices in the room under one label" },
    });

    test("marks its lines in the stretch unclear, keeps a line a range gives a voice, and leaves the rest of the label", () => {
        const record = meetingRecordSchema.parse({
            ...base,
            items: [
                label,
                item({
                    id: "i2",
                    kind: "speaker-range",
                    label: "Speaker 5",
                    fromSec: 10,
                    toSec: 10,
                    speaker: "Petr Novák",
                }),
            ],
        });
        const result = correctTranscript({ record, transcript: mixed, config, format: "txt", withSuggested: true });

        expect(result.entries.map((entry) => entry.speaker)).toEqual([
            '[nejasné: "Speaker 5"]',
            "Petr Novák",
            '[nejasné: "Speaker 5"]',
            "Speaker 5",
        ]);
        expect(result.outcomes.find((outcome) => outcome.item === "i1")).toEqual({
            item: "i1",
            status: "applied",
            lines: [
                { index: 0, startSec: 0 },
                { index: 2, startSec: 20 },
            ],
        });
    });

    test("is shadowed when ranges give every line a voice, and not found on a label with no line there", () => {
        const record = meetingRecordSchema.parse({
            ...base,
            items: [
                { ...label, toSec: 10 },
                item({
                    id: "i2",
                    kind: "speaker-range",
                    label: "Speaker 5",
                    fromSec: 0,
                    toSec: 10,
                    speaker: "Petr Novák",
                }),
                { ...label, id: "i3", label: "Speaker 9" },
            ],
        });
        const outcomes = correctTranscript({
            record,
            transcript: mixed,
            config,
            format: "txt",
            withSuggested: true,
        }).outcomes;

        expect(outcomes.find((outcome) => outcome.item === "i1")?.status).toBe("shadowed");
        expect(outcomeText(outcomes.find((outcome) => outcome.item === "i3")!)).toBe(
            'i3 did not apply: no line of "Speaker 9" from 00:00 to 00:30'
        );
    });

    test("an applied term does not give a label a voice", () => {
        const record = meetingRecordSchema.parse({
            ...base,
            items: [
                { ...label, toSec: 0 },
                item({ id: "i2", kind: "term", heard: "Začneme", proposed: "Pokračujeme", atSec: 0, scope: "line" }),
            ],
        });
        const result = correctTranscript({ record, transcript: mixed, config, format: "txt", withSuggested: true });
        expect(result.entries[0]?.text).toContain("Pokračujeme");
        expect(result.entries[0]?.speaker).toContain("nejasné");
        expect(result.outcomes.find((outcome) => outcome.item === "i1")).toMatchObject({ status: "applied" });
    });

    test("a rejected label item changes nothing", () => {
        const record = meetingRecordSchema.parse({ ...base, items: [{ ...label, status: "rejected" }] });
        const result = correctTranscript({ record, transcript: mixed, config, format: "txt", withSuggested: true });

        expect(result.entries.map((entry) => entry.speaker)).toEqual(mixed.map((entry) => entry.speaker));
    });
});

test("later ranges shadow earlier outcomes", () => {
    const result = applyCorrections([line("Voice", 5, "Hello")], {
        ranges: [
            { item: "i1", label: "Voice", fromSec: 5, toSec: 5, speaker: "Alice" },
            { item: "i2", label: "Voice", fromSec: 5, toSec: 5, speaker: "Bob" },
        ],
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ item: "i1", status: "shadowed", by: "i2" }));
    expect(result.outcomes).toContainEqual(expect.objectContaining({ item: "i2", status: "applied" }));
});

test("an addressed term does not move to another line at the same time", () => {
    const result = applyCorrections([line("Voice", 5, "Hello"), line("Voice", 5, "Ada")], {
        terms: [{ item: "i1", atSec: 5, line: 0, heard: "Ada", replacement: "Bob" }],
    });
    expect(result.entries[1]?.text).toBe("Ada");
    expect(result.outcomes).toContainEqual(expect.objectContaining({ item: "i1", status: "not-found" }));
});

test("a join after blank lines still reports a missing predecessor", () => {
    const result = applyCorrections([line("Voice", 0, ""), line("Voice", 5, "suffix")], {
        joins: [{ item: "i1", atSec: 5 }],
    });
    expect(result.outcomes).toContainEqual(expect.objectContaining({ item: "i1", status: "not-found" }));
});

describe("question-owned transcript uncertainty", () => {
    test.each([0.4, 0.5, 0.6, 0.95, 1])("keeps a %s guess until a real answer, across readers", async (confidence) => {
        const record = meetingRecordSchema.parse({
            ...base,
            items: [
                item({
                    id: "i1",
                    kind: "speaker-range",
                    status: "suggested",
                    label: "Voice",
                    fromSec: 5,
                    toSec: 5,
                    speaker: "B Example",
                    confidence,
                }),
                item({
                    id: "i2",
                    kind: "question",
                    status: "suggested",
                    about: "speaker",
                    fromSec: 0,
                    toSec: 10,
                    question: "Who?",
                    choices: ["A Example", "B Example", "both"],
                    decides: ["i1"],
                }),
            ],
        });
        const source = [line("Voice", 5, "Raw words."), line("Other", 20, "Unchanged.")];
        const render = (withSuggested: boolean) =>
            correctTranscript({ record, transcript: source, config, format: "txt", withSuggested, dictionary: false });
        const guess = `[B Example: ${Math.round(confidence * 100)} %]`;
        expect(render(true).entries[0]!.speaker).toBe(guess);
        const choices = render(false).entries[0]!.speaker;
        expect(choices).toBe('[nejasné: "Voice"; 1) A Example 2) B Example 3) both]');
        const entries = render(true).entries;
        expect(transcriptTextLines(groupTurns(entries), false).join("\n")).toContain(guess);
        expect(transcriptMarkdown(groupTurns(entries), false)).toContain(guess);
        expect(SafeJSON.parse(SafeJSON.stringify(entries))).toEqual(entries);
        expect(source[0]).toEqual(line("Voice", 5, "Raw words."));
        expect(entries[1]).toEqual(source[1]!);
        answerQuestion(record, "i2", { answer: "A Example", now: "2026-11-03T10:00:00.000Z" });
        const dir = await mkdtemp(join(tmpdir(), "uncertainty-answer-"));
        const stored = `${dir}/record.json`;
        await writeFile(stored, SafeJSON.stringify(record));
        const reopened = meetingRecordSchema.parse(SafeJSON.parse(await readFile(stored, "utf8")));
        expect(reopened.items[0]?.status).toBe("confirmed");
        expect(
            correctTranscript({ record: reopened, transcript: source, config, format: "json", withSuggested: true })
                .entries[0]?.speaker
        ).toBe("A Example");
    });

    test("unasked suggestions retain their threshold and explicit confirmations render plainly", () => {
        const source = [line("Voice", 5, "Raw words.")];
        const range = item({
            id: "i1",
            kind: "speaker-range",
            status: "suggested",
            label: "Voice",
            fromSec: 5,
            toSec: 5,
            speaker: "B Example",
            confidence: 0.6,
        });
        const render = (status: "suggested" | "confirmed", confidence: number, withSuggested: boolean) =>
            correctTranscript({
                record: meetingRecordSchema.parse({ ...base, items: [{ ...range, status, confidence }] }),
                transcript: source,
                config,
                format: "txt",
                withSuggested,
                dictionary: false,
            });
        expect(render("suggested", 0.6, false).entries[0]?.speaker).toBe("Voice");
        expect(render("suggested", 0.6, true).entries[0]?.speaker).toBe("[B Example: 60 %]");
        expect(render("suggested", 0.4, true).entries[0]?.speaker).toBe("[B Example: 40 %]");
        expect(render("confirmed", 0.4, false).entries[0]?.speaker).toBe("B Example");
    });

    test.each(["txt", "md", "json"] as const)("keeps a supplied final term mark once in %s", (format) => {
        const proposed = '[nejasné: "x"; 1) a 2) b]';
        const record = meetingRecordSchema.parse({
            ...base,
            items: [
                item({
                    id: "i1",
                    kind: "term",
                    status: "suggested",
                    heard: "x",
                    proposed,
                    confidence: 0.45,
                    scope: "line",
                    atSec: 5,
                }),
            ],
        });
        const source = [line("Voice", 5, "Use x here."), line("Voice", 10, "Keep x here.")];
        const result = correctTranscript({
            record,
            transcript: source,
            config,
            format,
            withSuggested: true,
            dictionary: false,
        });
        expect(result.entries.map((entry) => entry.text)).toEqual([`Use ${proposed} here.`, "Keep x here."]);
        expect(source[0]?.text).toBe("Use x here.");
    });
});

test("one persisted stem item keeps Czech endings across corrected lines", async () => {
    const transcript = [
        line("Alice", 5, "i na browsera"),
        line("Alice", 8, "i na browseru"),
        line("Alice", 10, "i na browserovéx"),
    ];
    const prepared = prepareFindings({
        items: [],
        transcript,
        findings: [
            findingSchema.parse({
                kind: "term",
                at: 5,
                heard: "i na browser",
                heardStem: "i na browser",
                proposedStem: "in-app browser",
                confidence: 0.9,
                reason: "confirmed stem",
            }),
        ],
    });
    const folder = await mkdtemp(join(tmpdir(), "stem-roundtrip-"));
    const file = join(folder, "meeting.json");
    await writeFile(
        file,
        SafeJSON.stringify({ ...base, items: prepared.added.map((item) => ({ ...item, status: "confirmed" })) })
    );
    const reopened = meetingRecordSchema.parse(SafeJSON.parse(await readFile(file, "utf8")));
    expect(reopened.items[0]).toMatchObject({ heardStem: "i na browser", proposedStem: "in-app browser" });
    const corrected = correctTranscript({ record: reopened, transcript, config, format: "md", dictionary: false });
    expect(corrected.entries.map((entry) => entry.text)).toEqual([
        "in-app browsera",
        "in-app browseru",
        "i na browserovéx",
    ]);
});

test("a persisted confirmed removal hides only the matched speech line", async () => {
    const transcript = [line("Alice", 5, "Fixture task done."), line("Alice", 100, "Fixture task done.")];
    const folder = await mkdtemp(join(tmpdir(), "speech-roundtrip-"));
    const file = join(folder, "meeting.json");
    const saved = {
        ...base,
        items: [item({ id: "i1", kind: "removal", fromSec: 5, toSec: 5, heard: "Fixture task done." })],
    };
    await writeFile(file, SafeJSON.stringify(saved));
    const reopened = meetingRecordSchema.parse(SafeJSON.parse(await readFile(file, "utf8")));
    expect(
        correctTranscript({ record: reopened, transcript, config, format: "txt", dictionary: false }).entries.map(
            (line) => line.startSec
        )
    ).toEqual([100]);
    expect(transcript).toHaveLength(2);
    const transformed = applyCorrections(transcript, {
        removals: [{ item: "i1", fromSec: 5, toSec: 5, heard: "Fixture task done." }],
        terms: [{ heard: "Fixture", replacement: "Changed" }],
    });
    expect(transformed.entries.map((line) => line.startSec)).toEqual([100]);
});

test("a line-scoped stem fixes the addressed inflected form and leaves its neighbour", () => {
    const transcript = [line("Alice", 5, "i na browserem"), line("Alice", 8, "i na browseru")];
    const prepared = prepareFindings({
        items: [],
        transcript,
        findings: [
            findingSchema.parse({
                kind: "term",
                at: 5,
                heard: "i na browser",
                heardStem: "i na browser",
                proposedStem: "in-app browser",
                scope: "line",
                confidence: 0.9,
                reason: "one addressed occurrence",
            }),
        ],
    });
    expect(prepared.warnings).toEqual([]);
    const record = meetingRecordSchema.parse({
        ...base,
        items: prepared.added.map((item) => ({ ...item, status: "confirmed" })),
    });
    expect(
        correctTranscript({ record, transcript, config, format: "txt", dictionary: false }).entries.map(
            (entry) => entry.text
        )
    ).toEqual(["in-app browserem", "i na browseru"]);
});

test("an assignment reaches a join's voice within the line tolerance once, never twice", () => {
    const joinsAt = (atSec: number) =>
        correctionsOf(
            meetingRecordSchema.parse({
                ...base,
                speakers: {
                    ...base.speakers,
                    assignments: [
                        {
                            id: "a1",
                            label: "Speaker 5",
                            fromSec: 10,
                            toSec: 10,
                            person: "Alice Example",
                            at: "2026-11-03T10:00:00.000Z",
                        },
                    ],
                },
                items: [item({ id: "i1", kind: "join", atSec, speaker: "Speaker 5" })],
            }),
            config,
            { format: "txt", dictionary: false }
        ).joins?.[0]?.speaker;

    expect(joinsAt(9.6)).toBe("Alice Example");
    expect(joinsAt(9.25)).toBe("Speaker 5");
});

test("a marked term anchors on its literal heard word, as its mark applies", () => {
    const marked = findingSchema.parse({
        kind: "term",
        at: 5,
        heard: "browser",
        heardStem: "browser",
        proposedStem: "viewer",
        meaning: "the in-app viewer",
        confidence: 0.9,
        reason: "a marked stem",
    });
    const inflected = [line("Alice", 5, "otevři to v browserem")];
    expect(() => prepareFindings({ items: [], transcript: inflected, findings: [marked] })).toThrow(/browser/);
    const prepared = prepareFindings({ items: [], transcript: inflected, findings: [marked], force: true });
    expect(checkAnchors(prepared.added, inflected).warnings).toEqual([
        `${prepared.added[0]!.id}: no line with "browser" starts at 00:05`,
    ]);

    const literal = [line("Alice", 5, "otevři to v browser")];
    const record = meetingRecordSchema.parse({
        ...base,
        items: prepareFindings({ items: [], transcript: literal, findings: [marked] }).added.map((one) => ({
            ...one,
            status: "confirmed",
        })),
    });
    expect(
        correctTranscript({ record, transcript: literal, config, format: "txt", dictionary: false }).outcomes
    ).toMatchObject([{ status: "applied" }]);
});

test("only an open speaker question marks its lines questioned", () => {
    const questioned = (fields: Record<string, unknown>) =>
        correctTranscript({
            record: meetingRecordSchema.parse({
                ...base,
                items: [item({ id: "i1", kind: "question", fromSec: 0, toSec: 0, question: "Who?", ...fields })],
            }),
            transcript: transcript.slice(0, 1),
            config,
            format: "txt",
            dictionary: false,
        }).entries[0]?.questioned;

    expect(questioned({ about: "speaker", status: "suggested" })).toBe(true);
    expect(questioned({ about: "speaker", status: "confirmed", answer: "Alice Example" })).toBeUndefined();
    expect(questioned({ about: "speaker", status: "rejected" })).toBeUndefined();
    expect(questioned({ about: "term", heard: "Jak", status: "suggested" })).toBeUndefined();
});

test("a multi-voice split cuts only its own source line, with distinct ids, words and times", () => {
    const timed = (location: number, length: number, startSec: number) => ({
        range: { location, length },
        startSec,
        endSec: startSec + 0.4,
        sourceId: "l1",
    });
    const source: TranscriptEntry[] = [
        {
            id: "l1",
            speaker: "Voice",
            startSec: 10,
            text: "First sentence. Second sentence.",
            words: [timed(0, 5, 10), timed(6, 9, 10.4), timed(16, 6, 11.5), timed(23, 9, 12)],
        },
        { id: "l2", speaker: "Voice", startSec: 15, text: "Another sentence here." },
    ];
    const record = meetingRecordSchema.parse({
        ...base,
        items: [
            item({
                id: "i1",
                kind: "speaker-range",
                label: "Voice",
                fromSec: 10,
                toSec: 15,
                speaker: "Alice Example + Bob Example",
                voices: ["Alice Example", "Bob Example"],
                segments: [
                    { fromWord: 0, speaker: "Alice Example" },
                    { fromWord: 2, speaker: "Bob Example" },
                ],
            }),
        ],
    });
    const entries = correctTranscript({
        record,
        transcript: source,
        config: meetingsConfigSchema.parse({ languages: { cs: { render: { unclearLabel: "unclear" } } } }),
        format: "json",
        dictionary: false,
    }).entries;

    expect(entries.map((entry) => [entry.id, entry.speaker, entry.text, entry.startSec])).toEqual([
        ["l1", "Alice Example", "First sentence.", 10],
        ["l1#1", "Bob Example", "Second sentence.", 11.5],
        ["l2", "[unclear: Alice Example + Bob Example]", "Another sentence here.", 15],
    ]);
    expect(entries[0]?.words?.map((word) => word.range)).toEqual([
        { location: 0, length: 5 },
        { location: 6, length: 9 },
    ]);
    expect(entries[1]?.words?.map((word) => word.range)).toEqual([
        { location: 0, length: 6 },
        { location: 7, length: 9 },
    ]);
});
