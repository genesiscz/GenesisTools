import { describe, expect, test } from "bun:test";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { meetingItemSchema, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { applyCorrections } from "@genesiscz/utils/transcribe/apply";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { checkAnchors, correctTranscript, ledgerEntryFor, outcomeText } from "./transcript-corrections";

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
            heard: "redakt",
            fixed: "Redux",
            item: "i1",
        });
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
});
