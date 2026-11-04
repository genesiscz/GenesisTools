import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { checkImageDimensions } from "@genesiscz/utils/image/dimensions";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { voiceRuns } from "@genesiscz/utils/meetings/energy";
import { MEETING_PLATFORM_IDS } from "@genesiscz/utils/meetings/platform";
import { MeetingStore, meetingItemSchema, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { writePidFile } from "@genesiscz/utils/process/pidfile";
import { callRecorder, listLiveRecordings, RecorderClient, RPC_ERRORS } from "@genesiscz/utils/screen-recorder/live";
import {
    CaptureError,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
} from "@genesiscz/utils/screen-recorder/types";
import { Storage } from "@genesiscz/utils/storage/storage";
import { applyCorrections } from "@genesiscz/utils/transcribe/apply";
import { groupTurns } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { createCanvas } from "@napi-rs/canvas";
import { CallTimeline } from "./lib/call-timeline";
import { suggestDictionary } from "./lib/dictionary-suggest";
import { captionSegments } from "./lib/editor-project";
import { findingItems, findingProblems, findingsFileSchema } from "./lib/findings";
import { MEETING_PLATFORMS, platformOfSourceName, speakingEvidence } from "./lib/platforms";
import { teamsAttendanceFromJson } from "./lib/platforms/teams";
import { selectQuestions } from "./lib/question-select";
import {
    answerQuestion,
    heardContext,
    openQuestions,
    propagateAnswer,
    type QuestionContext,
    questionFor,
    skipQuestion,
    splitQuestion,
} from "./lib/questions";
import { rawMeeting } from "./lib/raw";
import { meetingLiveId, pieceTargets, type RecorderNote, recorderFiles, runRecorder } from "./lib/recorder";
import { framesAt, framesAtPerDisplay, recordedSpans, recordingSummary } from "./lib/screen";
import { framesMatching, ocrRowSchema, renderScreenBoxes } from "./lib/screen-boxes";
import { showText } from "./lib/show-text";
import { suggestItems } from "./lib/suggest";
import { correctionsOf } from "./lib/transcript-corrections";
import { transcriptDocument } from "./lib/transcript-document";
import { type WatchDeps, type WatchNote, watchOnce } from "./lib/watch";

function line(speaker: string, startSec: number, text: string, speakerId?: number): TranscriptEntry {
    return { speaker, startSec, text, speakerId };
}

const meeting: SourceMeeting = {
    sourceMeetingId: "m1",
    title: "Planning",
    start: "2026-11-02T14:00:00.000Z",
    participants: [],
    speakers: [
        { speakerId: 1, name: "Alice Example", origin: "platform" },
        { speakerId: 2, name: "Carol Example", origin: "llm" },
    ],
    transcript: [
        line("Alice Example", 0, "Začneme.", 1),
        line("Carol Example", 10, "Já už musím jít, mějte se.", 2),
        line("Alice Example", 14, "Jo, čau.", 1),
        line("Carol Example", 80, "Tak já pokračuju s databází.", 2),
        line("Speaker 5", 120, "jak to vlastně dot"),
        line("Alice Example", 123.2, "áhnu do konce."),
    ],
    folders: [],
};

const record = meetingRecordSchema.parse({
    id: "2026-11-02_15-00-planning",
    title: "Planning",
    start: meeting.start,
    createdAt: meeting.start,
    createdBy: "new",
});

describe("suggestItems", () => {
    test("a later round asks existing findings that the first budget left out", () => {
        const pending = meetingRecordSchema.parse({
            ...record,
            items: [0, 100].map((atSec, index) => ({
                id: `i${index + 1}`,
                kind: "term",
                status: "suggested",
                heard: `API${index}`,
                proposed: `API${index}Fixed`,
                atSec,
                scope: "line",
                confidence: 0.2,
                rules: [],
                suggestedAt: meeting.start,
            })),
        });
        const options = {
            record: pending,
            meeting,
            rules: [],
            dictionary: { abbrExpansion: "every" as const, entries: [] },
            sourceWords: [],
            now: meeting.start,
            questionBudget: 1,
        };
        const first = suggestItems(options);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ kind: "question", decides: ["i1"] });
        pending.items.push(...first);
        const second = suggestItems(options);
        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({ kind: "question", decides: ["i2"] });
        pending.items.push(...second);
        expect(suggestItems(options)).toEqual([]);
    });

    test("a goodbye another label answered becomes a range, a cut word becomes a join, each with its rules", () => {
        const items = suggestItems({
            record,
            meeting,
            rules: ["speakers"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items).toContainEqual(
            expect.objectContaining({
                kind: "speaker-range",
                label: "Carol Example",
                fromSec: 80,
                rules: ["R1", "R5", "R13"],
                status: "suggested",
            })
        );
        expect(items).toContainEqual(
            expect.objectContaining({ kind: "join", atSec: 123.2, joined: "dotáhnu", speaker: "Alice Example" })
        );
        expect(items.map((item) => item.id)).toEqual(items.map((_, index) => `i${index + 1}`));
    });

    test("an item the record already has, in any status, is not suggested again", () => {
        const first = suggestItems({
            record,
            meeting,
            rules: ["speakers"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            now: "2026-11-02T15:00:00.000Z",
        });
        const decided = { ...record, items: first.map((item) => ({ ...item, status: "rejected" as const })) };
        const again = suggestItems({
            record: decided,
            meeting,
            rules: ["speakers"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            now: "2026-11-02T16:00:00.000Z",
        });

        expect(first.length).toBeGreaterThan(0);
        expect(again).toEqual([]);
    });

    test("with attendance, a range spoken while only one person was in the call names that person", () => {
        const items = suggestItems({
            record,
            meeting,
            rules: ["speakers"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            presence: [
                { name: "Alice Example", fromSec: 0, toSec: 200 },
                { name: "Example Carol", fromSec: 0, toSec: 30 },
            ],
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items).toContainEqual(
            expect.objectContaining({
                kind: "speaker-range",
                label: "Carol Example",
                fromSec: 80,
                speaker: "Alice Example",
                rules: ["RA"],
            })
        );
    });
});

describe("suggestDictionary", () => {
    test("source rows become fix or term, twice-confirmed corrections become fix, known and ignored values are left out", () => {
        const correction = {
            at: "t",
            meeting: "m",
            kind: "term" as const,
            heard: "Zushtent",
            fixed: "Zustand",
            item: "i1",
        };
        const suggestions = suggestDictionary({
            dictionary: { abbrExpansion: "every", entries: [{ type: "term", value: "GenesisKit" }] },
            sourceId: "wisprflow",
            sourceWords: [
                { value: "Tanstack", replacement: "TanStack" },
                { value: "GenesisKit" },
                { value: "MVNO" },
                { value: "Ignored" },
                { value: "transcript" },
            ],
            ignore: ["ignored"],
            corrections: [correction, { ...correction, at: "t2" }, { ...correction, heard: "redakt", fixed: "Redux" }],
        });

        expect(suggestions).toEqual([
            { entry: { type: "fix", value: "Zushtent", substitution: "Zustand" }, from: "confirmed 2 times" },
            { entry: { type: "fix", value: "Tanstack", substitution: "TanStack" }, from: "wisprflow" },
            { entry: { type: "term", value: "MVNO" }, from: "wisprflow" },
        ]);
    });
});

describe("evidence rule", () => {
    test("the user's microphone under another label becomes the user; a mixed line asks to listen", () => {
        const items = suggestItems({
            record,
            meeting: {
                ...meeting,
                transcript: [
                    line("Carol Example", 0, "Já to udělám.", 2),
                    line("Carol Example", 10, "A ještě tohle.", 2),
                    line("Carol Example", 200, "Půl na půl tady.", 2),
                ],
            },
            rules: ["evidence"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            evidence: {
                selfName: "Alice Example",
                segments: [
                    { startSec: 0, endSec: 20, channel: "mic" },
                    { startSec: 200, endSec: 203, channel: "mic" },
                    { startSec: 203, endSec: 205, channel: "system", liveName: "Carol Example" },
                ],
                speaking: [],
                files: [],
            },
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items).toEqual([
            expect.objectContaining({
                label: "Carol Example",
                fromSec: 0,
                toSec: 10,
                speaker: "Alice Example",
                rules: ["E1"],
                confidence: 0.95,
            }),
            expect.objectContaining({
                fromSec: 200,
                speaker: "Alice Example",
                evidence: expect.objectContaining({ listen: true, note: expect.stringContaining("listening") }),
            }),
        ]);
    });
});

describe("evidence ranges (R4.1)", () => {
    test("a line of the label without a finding closes the range, so the range never covers it", () => {
        const items = suggestItems({
            record,
            meeting: {
                ...meeting,
                transcript: [
                    line("Carol Example", 0, "Já to udělám.", 2),
                    line("Carol Example", 10, "Tohle říká Carol.", 2),
                    line("Carol Example", 20, "A ještě tohle.", 2),
                ],
            },
            rules: ["evidence"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            evidence: {
                selfName: "Alice Example",
                segments: [
                    { startSec: 0, endSec: 10, channel: "mic" },
                    { startSec: 10, endSec: 20, channel: "system", liveName: "Carol Example" },
                    { startSec: 20, endSec: 30, channel: "mic" },
                ],
                speaking: [],
                files: [],
            },
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items.map((item) => item.kind === "speaker-range" && [item.fromSec, item.toSec])).toEqual([
            [0, 0],
            [20, 20],
        ]);
    });
});

describe("--with-suggested (R4.2)", () => {
    test("applies a suggested item at applyAbove or more and a person's own; a lower one is marked unclear", () => {
        const range = (id: string, fromSec: number, speaker: string, confidence?: number) =>
            meetingItemSchema.parse({
                id,
                kind: "speaker-range",
                status: "suggested",
                label: "Carol Example",
                fromSec,
                toSec: fromSec,
                speaker,
                ...(confidence === undefined ? {} : { confidence }),
                rules: [confidence === undefined ? MeetingRule.User : MeetingRule.Channel],
                suggestedAt: "2026-11-02T15:00:00.000Z",
            });
        const withItems = meetingRecordSchema.parse({
            ...record,
            items: [
                range("i1", 0, "Alice Example", 0.5),
                range("i2", 10, "Bob Example", 0.44),
                range("i3", 20, "Dave Example"),
            ],
        });
        const entries = [
            line("Carol Example", 0, "Já to udělám."),
            line("Carol Example", 10, "Možná já."),
            line("Carol Example", 20, "Já taky."),
        ];
        const config = meetingsConfigSchema.parse({});
        const shown = (withSuggested: boolean) =>
            applyCorrections(
                entries,
                correctionsOf(withItems, config, { withSuggested, dictionary: false, format: "txt" })
            ).entries.map((entry) => entry.speaker);

        expect(shown(true)).toEqual([
            "Alice Example",
            '[nejasné: "Carol Example"; 1) Bob Example 44 %]',
            "Dave Example",
        ]);
        expect(shown(false)).toEqual(["Carol Example", "Carol Example", "Carol Example"]);
    });
});

describe("energy over the live segments (R4.3)", () => {
    const base = {
        record,
        rules: ["evidence" as const],
        dictionary: { abbrExpansion: "every" as const, entries: [] },
        sourceWords: [],
        now: "2026-11-02T15:00:00.000Z",
    };
    const callSegment = {
        selfName: "Alice Example",
        segments: [{ startSec: 0, endSec: 30, channel: "system" as const, liveName: "Carol Example" }],
        speaking: [{ tSec: 1, speaking: ["Carol Example"], muted: [] }],
        files: [],
    };
    const replies = {
        ...meeting,
        transcript: [
            line("Carol Example", 0, "Ano."),
            line("Alice Example", 10, "Jasně."),
            line("Carol Example", 20, "Dál."),
        ],
    };
    const energyAt = (shares: Record<number, number>) => (fromSec: number) => shares[fromSec];

    test("a reply the microphone's energy holds is the user's, though the segment, E3 and E4 say the call", () => {
        const items = suggestItems({
            ...base,
            meeting: replies,
            evidence: callSegment,
            energyMicShare: energyAt({ 0: 0.99, 10: 0.97, 20: 0.4 }),
        });

        expect(items).toEqual([
            expect.objectContaining({
                label: "Carol Example",
                fromSec: 0,
                toSec: 0,
                speaker: "Alice Example",
                rules: ["energy"],
                confidence: 0.75,
            }),
        ]);
    });

    test("a line the call's energy holds is never the user's, though the segments said the microphone", () => {
        const items = suggestItems({
            ...base,
            meeting: replies,
            evidence: { ...callSegment, segments: [{ startSec: 0, endSec: 30, channel: "mic" as const }] },
            energyMicShare: energyAt({ 0: 0.05, 10: 0.03, 20: 0.95 }),
        });
        const ranges = items.filter((item) => item.kind === "speaker-range");

        expect(ranges.some((item) => item.fromSec === 0)).toBe(false);
        expect(ranges.find((item) => item.fromSec === 10)).toMatchObject({ label: "Alice Example", rules: ["energy"] });
        expect(ranges.find((item) => item.fromSec === 20)).toMatchObject({
            speaker: "Alice Example",
            confidence: 0.98,
        });
    });
});

describe("energy where the live segments are mixed", () => {
    const base = {
        record,
        rules: ["evidence" as const],
        dictionary: { abbrExpansion: "every" as const, entries: [] },
        sourceWords: [],
        now: "2026-11-02T15:00:00.000Z",
    };
    const lines = {
        ...meeting,
        transcript: [
            line("Carol Example", 0, "To je moje."),
            line("Carol Example", 10, "A tohle taky."),
            line("Carol Example", 20, "Hm."),
            line("Carol Example", 30, "Konec."),
        ],
    };
    // Each line is 10 s: 4 s of the microphone in the first and third, 6 s in the second.
    const evidence = {
        selfName: "Alice Example",
        segments: [
            { startSec: 0, endSec: 4, channel: "mic" as const },
            { startSec: 4, endSec: 10, channel: "system" as const, liveName: "Carol Example" },
            { startSec: 10, endSec: 16, channel: "mic" as const },
            { startSec: 16, endSec: 24, channel: "system" as const, liveName: "Carol Example" },
            { startSec: 24, endSec: 30, channel: "system" as const, liveName: "Carol Example" },
        ],
        speaking: [],
        files: [],
    };
    const at = (items: ReturnType<typeof suggestItems>, sec: number) =>
        items.find((item) => item.kind === "speaker-range" && item.fromSec === sec);

    test("the energy's majority decides: 0.7 or more on the microphone is the user, to ask; under 0.5 never", () => {
        const items = suggestItems({
            ...base,
            meeting: lines,
            evidence,
            energyMicShare: (fromSec) => ({ 0: 0.8, 10: 0.4, 20: 0.65 })[fromSec],
        });

        expect(at(items, 0)).toMatchObject({ speaker: "Alice Example", rules: ["energy"], confidence: 0.55 });
        expect(at(items, 0)?.evidence).toMatchObject({ listen: true });
        expect(at(items, 10)).toBeUndefined();
        expect(at(items, 20)).toBeUndefined();
    });

    test("a platform label whose person E3 alone shows speaking keeps a mixed line the energy is not sure of", () => {
        const labelled = {
            ...lines,
            speakers: [{ speakerId: 1, name: "Carol Example", origin: "platform" }],
        };
        const shown = { ...evidence, speaking: [{ tSec: 10, speaking: ["Carol Example"], muted: [] }] };
        const energyMicShare = () => 0.6;

        expect(at(suggestItems({ ...base, meeting: labelled, evidence: shown, energyMicShare }), 10)).toBeUndefined();
        expect(at(suggestItems({ ...base, meeting: labelled, evidence, energyMicShare }), 10)).toMatchObject({
            speaker: "Alice Example",
            rules: ["E1", "energy"],
        });
    });
});

describe("a line no live segment covers", () => {
    test("a sure energy share names its channel; anything less leaves it to its label", () => {
        const items = suggestItems({
            record,
            meeting: {
                ...meeting,
                transcript: [
                    line("Carol Example", 0, "Hm."),
                    line("Carol Example", 10, "Jo."),
                    line("Alice Example", 20, "No."),
                    line("Carol Example", 30, "Dobře."),
                ],
            },
            rules: ["evidence"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            evidence: {
                selfName: "Alice Example",
                segments: [{ startSec: 30, endSec: 40, channel: "system", liveName: "Carol Example" }],
                speaking: [],
                files: [],
            },
            energyMicShare: (fromSec) => ({ 0: 0.97, 10: 0.6, 20: 0.97, 30: 0.05 })[fromSec],
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items).toEqual([
            expect.objectContaining({
                fromSec: 0,
                toSec: 0,
                speaker: "Alice Example",
                rules: ["energy"],
                confidence: 0.75,
            }),
        ]);
    });
});

describe("a label the platform named", () => {
    test("keeps a call line when E3 and E4 agree on someone else; a label the transcriber named does not", () => {
        const run = (origin: string) =>
            suggestItems({
                record,
                meeting: {
                    ...meeting,
                    speakers: [{ speakerId: 1, name: "Bob Example", origin }],
                    transcript: [line("Bob Example", 0, "Ano.", 1), line("Bob Example", 10, "Dobře.", 1)],
                },
                rules: ["evidence"],
                dictionary: { abbrExpansion: "every", entries: [] },
                sourceWords: [],
                evidence: {
                    selfName: "Alice Example",
                    segments: [{ startSec: 0, endSec: 5, channel: "system", liveName: "Rob Example" }],
                    speaking: [{ tSec: 1, speaking: ["Rob Example"], muted: [] }],
                    files: [],
                },
                now: "2026-11-02T15:00:00.000Z",
            });

        expect(run("platform")).toEqual([]);
        expect(run("llm")).toEqual([expect.objectContaining({ speaker: "Rob Example", rules: ["E1", "E3", "E4"] })]);
    });
});

describe("own label (R17)", () => {
    test("in a dialogue with a person's own label, the other voice E3 shows is the line's, and that person's live name loses", () => {
        const items = suggestItems({
            record,
            meeting: {
                ...meeting,
                speakers: [
                    { speakerId: 1, name: "Bob Example", origin: "platform" },
                    { speakerId: 2, name: "Carol Example", origin: "llm" },
                ],
                transcript: [
                    line("Bob Example", 0, "Jak to máš?", 1),
                    line("Carol Example", 4, "Mám to hotové.", 2),
                    line("Carol Example", 60, "A ještě tohle.", 2),
                ],
            },
            rules: ["evidence"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            evidence: {
                selfName: "Alice Example",
                segments: [{ startSec: 0, endSec: 70, channel: "system", liveName: "Bob Example" }],
                speaking: [
                    { tSec: 4, speaking: ["Bob Example", "Rob Example"], muted: [] },
                    { tSec: 60, speaking: ["Bob Example", "Rob Example"], muted: [] },
                ],
                files: [],
            },
            now: "2026-11-02T15:00:00.000Z",
        });
        const at = (sec: number) => items.find((item) => item.kind === "speaker-range" && item.fromSec === sec);

        expect(at(4)).toMatchObject({ speaker: "Rob Example", rules: ["E1", "E3", "R17"], confidence: 0.65 });
        expect(at(60)).toMatchObject({ speaker: "Bob Example", rules: ["E1", "E3", "E4"] });
    });
});

describe("a join and a range on the line after the cut", () => {
    test("the joined line takes the voice the range gives the line after the cut", () => {
        const item = (fields: Record<string, unknown>) =>
            meetingItemSchema.parse({ status: "suggested", suggestedAt: "2026-11-02T15:00:00.000Z", ...fields });
        const withItems = meetingRecordSchema.parse({
            ...record,
            items: [
                item({
                    id: "i1",
                    kind: "join",
                    atSec: 10,
                    speaker: "Carol Example",
                    joined: "dotáhnu",
                    confidence: 0.9,
                    rules: ["split-word"],
                }),
                item({
                    id: "i2",
                    kind: "speaker-range",
                    label: "Carol Example",
                    fromSec: 10,
                    toSec: 10,
                    speaker: "Alice Example",
                    confidence: 0.9,
                    rules: [MeetingRule.Channel],
                }),
            ],
        });
        const entries = [line("Speaker 5", 0, "Jak to dot"), line("Carol Example", 10, "áhnu do konce.")];
        const applied = applyCorrections(
            entries,
            correctionsOf(withItems, meetingsConfigSchema.parse({}), {
                withSuggested: true,
                dictionary: false,
                format: "txt",
            })
        );

        expect(applied.entries.map((entry) => [entry.speaker, entry.text])).toEqual([
            ["Alice Example", "Jak to dotáhnu"],
            ["Alice Example", "do konce."],
        ]);
    });
});

describe("a join of two whole words", () => {
    test("keeps the space between them, while a cut word is glued back", () => {
        const join = (joined: string, atSec: number) =>
            meetingItemSchema.parse({
                id: `i${atSec}`,
                kind: "join",
                status: "suggested",
                suggestedAt: "2026-11-02T15:00:00.000Z",
                atSec,
                joined,
                confidence: 0.9,
                rules: [MeetingRule.Agent],
            });
        const entries = [
            line("A", 0, "Tak já jsem"),
            line("B", 10, "zvědavej, co z toho bude."),
            line("A", 20, "Jak to dot"),
            line("B", 30, "áhnu do konce."),
        ];
        const applied = applyCorrections(
            entries,
            correctionsOf(
                meetingRecordSchema.parse({ ...record, items: [join("jsem zvědavej", 10), join("dotáhnu", 30)] }),
                meetingsConfigSchema.parse({}),
                { withSuggested: true, dictionary: false, format: "txt" }
            )
        );

        expect(applied.entries.map((entry) => entry.text)).toEqual([
            "Tak já jsem zvědavej,",
            "co z toho bude.",
            "Jak to dotáhnu",
            "do konce.",
        ]);
    });
});

describe("evidence rule after a leave", () => {
    test("a live name of someone who left is dropped; the speaking indicator among those still here guesses, to listen", () => {
        const items = suggestItems({
            record,
            meeting: {
                ...meeting,
                transcript: [line("Carol Example", 100, "Tak dál.", 2), line("Alice Example", 110, "Ano.", 1)],
            },
            rules: ["evidence"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            presence: [
                { name: "alice@example.com", self: true, fromSec: 0, toSec: 200 },
                { name: "Bob Example", fromSec: 0, toSec: 200 },
                { name: "Carol Example", fromSec: 0, toSec: 50 },
                { name: "Dave Example", fromSec: 0, toSec: 60 },
            ],
            evidence: {
                selfName: "Alice Example",
                segments: [{ startSec: 100, endSec: 110, channel: "system", liveName: "Dave Example" }],
                speaking: [{ tSec: 102, speaking: ["Bob Example", "Alice Example"], muted: [] }],
                files: [],
            },
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items).toEqual([
            expect.objectContaining({
                label: "Carol Example",
                speaker: "Bob Example",
                rules: ["E1", "E3", "RA"],
                confidence: 0.45,
            }),
        ]);
    });
});

describe("watchOnce", () => {
    const settings = { enabled: true, liveWithinSec: 30, stopAfterSilenceSec: 120, notify: true };
    const now = Date.parse("2026-11-02T15:10:00.000Z");
    const live = {
        sourceMeetingId: "w1",
        title: "Planning",
        startedAt: "2026-11-02T15:00:00.000Z",
        liveChangedAt: "2026-11-02T15:09:55.000Z",
    };
    let stores = 0;

    function harness(over: Partial<WatchDeps> = {}) {
        stores += 1;
        const runs: string[][] = [];
        const notes: string[] = [];
        const posted: WatchNote[] = [];
        const refreshed: string[] = [];
        let running = false;
        const deps: Partial<WatchDeps> = {
            refresh: async (meetingId, sourceRef) => {
                refreshed.push(`${meetingId} ${sourceRef}`);
                return record;
            },
            source: async () => ({ id: "wisprflow", label: "Wispr Flow" }),
            settings: async () => settings,
            liveRecording: async () => live,
            recorder: () =>
                running
                    ? {
                          running: true,
                          state: { meetingId: "m1", pid: 1, startedAt: "", display: 1, frames: 0, bytes: 0 },
                      }
                    : { running: false },
            run: async (args) => {
                runs.push(args);
                running = args[2] === "start";
                return { success: true, exitCode: 0, stderr: "" };
            },
            notify: async (note) => {
                notes.push(note.title);
                posted.push(note);
            },
            ...over,
        };
        return {
            store: new MeetingStore(new Storage(`meetings-watch-${stores}`)),
            deps,
            runs,
            notes,
            posted,
            refreshed,
        };
    }

    test("a recorder whose capture failed starts again after a pause, the notice left to the recorder; a stop asked for stays", async () => {
        const failed = {
            status: "stopped",
            stopReason: "failed",
            stoppedAt: "2026-11-02T15:10:30.000Z",
            warning: "capture failed 3 times in a row: peekaboo exited 1: Invalid input: Screen index 1 not found",
        };
        let recording: Record<string, unknown> = failed;
        const h = harness({ recording: () => recording });
        const later = (sec: number) => ({
            now: now + sec * 1000,
            deps: {
                ...h.deps,
                liveRecording: async () => ({ ...live, liveChangedAt: new Date(now + sec * 1000).toISOString() }),
            },
        });

        expect(await watchOnce(h.store, { deps: h.deps, now })).toBe("started");
        // The recorder ends on its own; harness `run` marks it running only for a start.
        await h.deps.run?.(["meetings", "record", "stop"]);

        expect(await watchOnce(h.store, later(60))).toBe("idle");
        expect(await watchOnce(h.store, later(160))).toBe("started");
        expect(h.runs.at(-1)).toEqual(["meetings", "record", "start", "--meeting", "m1", "--yes"]);
        expect(h.notes).toEqual(["Recording the screen"]);

        await h.deps.run?.(["meetings", "record", "stop"]);
        recording = { ...failed, stoppedAt: new Date(now + 170_000).toISOString() };

        expect(await watchOnce(h.store, later(200))).toBe("idle");
        expect(await watchOnce(h.store, later(300))).toBe("started");
        expect(h.notes).toHaveLength(1);

        await h.deps.run?.(["meetings", "record", "stop"]);
        recording = { status: "stopped", stopReason: "requested", stoppedAt: new Date(now + 310_000).toISOString() };

        expect(await watchOnce(h.store, later(900))).toBe("idle");
    });

    test("off: nothing happens", async () => {
        const h = harness({ settings: async () => ({ ...settings, enabled: false }) });

        expect(await watchOnce(h.store, { deps: h.deps, now })).toBe("disabled");
        expect(h.runs).toEqual([]);
    });

    test("a fresh Wispr recording starts one screen recording and a notification, then keeps it", async () => {
        const h = harness();

        expect(await watchOnce(h.store, { deps: h.deps, now })).toBe("started");
        expect(h.runs).toEqual([["meetings", "record", "start", "--source", "wisprflow:w1", "--yes"]]);
        expect(h.notes).toEqual(["Recording the screen"]);
        // A click must do something: a stop button, and a subtitle even before Wispr names the meeting.
        expect(h.posted[0]?.actions).toEqual([expect.objectContaining({ id: "stop", title: "Stop recording" })]);
        expect(h.posted[0]?.subtitle).toBeTruthy();
        expect(h.posted[0]?.message.startsWith(":")).toBe(false);

        const untitled = harness({ liveRecording: async () => ({ ...live, title: "" }) });
        await watchOnce(untitled.store, { deps: untitled.deps, now });
        expect(untitled.posted[0]?.subtitle).toMatch(/^Wispr Flow meeting since \d\d:\d\d$/);
        expect(await watchOnce(h.store, { deps: h.deps, now: now + 10_000 })).toBe("recording");
    });

    test("its own recording stops when Wispr goes silent; a recording a person started is left alone", async () => {
        const h = harness();
        await watchOnce(h.store, { deps: h.deps, now });

        expect(await watchOnce(h.store, { deps: h.deps, now: now + 200_000 })).toBe("stopped");
        expect(h.runs.at(-1)).toEqual(["meetings", "record", "stop"]);

        const other = harness({
            recorder: () => ({
                running: true,
                state: { meetingId: "by-hand", pid: 1, startedAt: "", display: 1, frames: 0, bytes: 0 },
            }),
        });
        expect(await watchOnce(other.store, { deps: other.deps, now })).toBe("busy");
        expect(other.runs).toEqual([]);
    });

    test("a failed stop retains ownership and retries on the next tick", async () => {
        const h = harness();
        await watchOnce(h.store, { deps: h.deps, now });
        const successfulRun = h.deps.run!;
        h.deps.run = async () => ({ success: false, exitCode: 1, stderr: "timeout" });
        expect(await watchOnce(h.store, { deps: h.deps, now: now + 200_000 })).toBe("failed");
        h.deps.run = successfulRun;
        expect(await watchOnce(h.store, { deps: h.deps, now: now + 215_000 })).toBe("stopped");
        expect(h.runs.at(-1)).toEqual(["meetings", "record", "stop"]);
    });

    test("a stop that failed keeps the recording the watcher's own, and the next look stops it again", async () => {
        let stopWorks = false;
        const h = harness();
        const run = h.deps.run!;
        h.deps.run = async (args) =>
            args[2] === "stop" && !stopWorks ? { success: false, exitCode: 1, stderr: "still running" } : run(args);
        await watchOnce(h.store, { deps: h.deps, now });

        expect(await watchOnce(h.store, { deps: h.deps, now: now + 200_000 })).toBe("failed");
        expect(existsSync(join(h.store.root, "watch-auto.json"))).toBe(true);

        stopWorks = true;

        expect(await watchOnce(h.store, { deps: h.deps, now: now + 215_000 })).toBe("stopped");
        expect(existsSync(join(h.store.root, "watch-auto.json"))).toBe(false);
    });

    test("an already stopped recorder still refreshes when the source meeting ends", async () => {
        const h = harness();
        await watchOnce(h.store, { deps: h.deps, now });
        h.deps.recorder = () => ({ running: false });
        h.deps.liveRecording = async () => null;
        expect(await watchOnce(h.store, { deps: h.deps, now: now + 15_000 })).toBe("idle");
        expect(h.refreshed).toEqual(["m1 wisprflow:w1"]);
        const auto = SafeJSON.parse(readFileSync(join(h.store.root, "watch-auto.json"), "utf8"), { strict: true });
        expect(auto.refreshUntil).toBeDefined();
    });

    test("when Wispr ends the meeting, the record is linked again until the source gives it an end", async () => {
        let source: typeof live | null = live;
        let ended = false;
        const h = harness({ liveRecording: async () => source });
        h.deps.refresh = async (meetingId, sourceRef) => {
            h.refreshed.push(`${meetingId} ${sourceRef}`);
            return ended ? { ...record, end: "2026-11-02T15:40:00.000Z" } : record;
        };
        await watchOnce(h.store, { deps: h.deps, now });
        source = null;

        expect(await watchOnce(h.store, { deps: h.deps, now: now + 15_000 })).toBe("stopped");
        expect(h.refreshed).toEqual(["m1 wisprflow:w1"]);

        ended = true;

        expect(await watchOnce(h.store, { deps: h.deps, now: now + 30_000 })).toBe("idle");
        expect(h.refreshed).toHaveLength(2);
        expect(existsSync(join(h.store.root, "watch-auto.json"))).toBe(false);
    });

    test("a start that failed (no grant) is not retried for the same meeting", async () => {
        const h = harness({
            run: async () => ({ success: false, exitCode: 1, stderr: "Screen Recording is not granted" }),
        });

        expect(await watchOnce(h.store, { deps: h.deps, now })).toBe("failed");
        expect(h.notes).toEqual(["Meeting not recorded"]);
        expect(await watchOnce(h.store, { deps: h.deps, now: now + 15_000 })).toBe("idle");
    });
});

describe("microphone scoring (R2.1)", () => {
    const base = {
        record,
        rules: ["evidence" as const],
        dictionary: { abbrExpansion: "every" as const, entries: [] },
        sourceWords: [],
        now: "2026-11-02T15:00:00.000Z",
    };
    const oneLine = {
        ...meeting,
        transcript: [line("Carol Example", 0, "Pošlu to zítra.", 2), line("Carol Example", 9, "Konec.", 2)],
    };

    test("an echo of the call's own words lowers the score and asks to listen", () => {
        const items = suggestItems({
            ...base,
            meeting: oneLine,
            evidence: {
                selfName: "Alice Example",
                segments: [
                    { startSec: 0, endSec: 8, channel: "mic", text: "Pošlu to zítra." },
                    { startSec: 0, endSec: 1, channel: "system", text: "pošlu to zítra", liveName: "Carol Example" },
                ],
                speaking: [],
                files: [],
            },
        });

        expect(items[0]).toMatchObject({
            speaker: "Alice Example",
            evidence: { echoLines: 1, note: expect.any(String) },
        });
        expect(items[0]!.confidence).toBeLessThan(0.6);
    });

    test("energy that agrees raises the score to at most 0.98; a loud call lowers it", () => {
        const evidence = {
            selfName: "Alice Example",
            segments: [{ startSec: 0, endSec: 9, channel: "mic" as const }],
            speaking: [],
            files: [],
        };
        // Only the first line: the second has no segment, and a sure share there would join the range.
        const agrees = suggestItems({
            ...base,
            meeting: oneLine,
            evidence,
            energyMicShare: (fromSec) => (fromSec === 0 ? 0.9 : undefined),
        });
        const loud = suggestItems({ ...base, meeting: oneLine, evidence, energyMicShare: () => 0.5 });

        expect(agrees[0]).toMatchObject({ confidence: 0.98, rules: ["E1", "energy"] });
        expect(loud[0]!.confidence).toBe(0.8);
        expect(loud[0]!.evidence).toMatchObject({ note: expect.any(String) });
    });

    test("the speaking indicator never counts against the user: Teams shows the user only as muted", () => {
        const items = suggestItems({
            ...base,
            meeting: oneLine,
            evidence: {
                selfName: "Alice Example",
                segments: [{ startSec: 0, endSec: 9, channel: "mic" }],
                speaking: [{ tSec: 1, speaking: ["Carol Example"], muted: ["Alice Example"] }],
                files: [],
            },
        });

        expect(items[0]).toMatchObject({ speaker: "Alice Example", confidence: 0.95 });
    });
});

describe("fuzzy dictionary suggestions (R2.5)", () => {
    test("a word close to a term but below the apply score becomes a term item with its score", () => {
        const items = suggestItems({
            record,
            meeting: { ...meeting, transcript: [line("Alice Example", 12, "A kubernetu zítra.", 1)] },
            rules: ["terms"],
            dictionary: {
                abbrExpansion: "every",
                fuzzy: { apply: 0.95, suggest: 0.8 },
                entries: [{ type: "term", value: "Kubernetes" }],
            },
            sourceWords: [],
            now: "2026-11-02T15:00:00.000Z",
        });

        expect(items).toContainEqual(
            expect.objectContaining({
                kind: "term",
                heard: "kubernetu",
                proposed: "Kubernetes",
                atSec: 12,
                // The phonetic check finds it too; the two agree in one item.
                rules: expect.arrayContaining(["dictionary-fuzzy"]),
            })
        );
    });
});

describe("questions (R2.3)", () => {
    const now = "2026-11-02T15:00:00.000Z";
    const withItems = (items: unknown[]) => meetingRecordSchema.parse({ ...record, items });
    const range = {
        id: "i1",
        kind: "speaker-range",
        status: "suggested",
        label: "Speaker 5",
        fromSec: 120,
        toSec: 140,
        speaker: "Alice Example",
        candidates: ["Carol Example", "Alice Example"],
        rules: ["E1"],
        evidence: { listen: true, endSec: 146 },
        suggestedAt: now,
    };

    // Speaker 5 says enough at 120 s to matter (15 words); 140 s holds only fillers.
    const transcript = [
        line(
            "Speaker 5",
            120,
            "Tak to bychom měli, ten export dat do nového systému připravíme do konce příštího týdne."
        ),
        line("Speaker 5", 140, "Jo, jo, mhm."),
        line("Bob Example", 146, "Dobře."),
    ];
    const context = (extra: Partial<QuestionContext> = {}): QuestionContext => ({
        listenBelow: 0.6,
        transcript,
        points: [],
        ...extra,
    });

    test("an unsure range that matters is asked, offering everyone present, the user under their own name", () => {
        const parsed = withItems([{ ...range, confidence: 0.45 }]).items[0]!;
        const withSelf = meetingRecordSchema.parse({
            ...record,
            participants: [{ name: "Alice Example", self: true }],
        });
        const presence = CallTimeline.stored(withSelf).named([
            { name: "Bob Example", fromSec: 0, toSec: 200 },
            { name: "alice@example.com", self: true, fromSec: 0, toSec: 200 },
            { name: "Dan Example", fromSec: 150, toSec: 200 },
        ]);
        expect(questionFor(parsed, context({ presence }))).toMatchObject({
            kind: "question",
            about: "speaker",
            fromSec: 120,
            toSec: 146,
            choices: ["Alice Example", "Carol Example", "Bob Example"],
            decides: ["i1"],
            clip: { fromSec: 120, toSec: 140 },
        });
    });

    test("a sure range, a mixed channel alone, or a range of fillers is not asked", () => {
        const sure = withItems([{ ...range, confidence: 0.7 }]).items[0]!;
        expect(questionFor(sure, context())).toBeUndefined();
        const fillers = withItems([{ ...range, fromSec: 140, toSec: 140, confidence: 0.3 }]).items[0]!;
        expect(questionFor(fillers, context())).toBeUndefined();
    });

    test("a term is asked only when it matters: seen twice, an identifier, or a decision", () => {
        const term = (extra: object) =>
            withItems([
                {
                    id: "i2",
                    kind: "term",
                    status: "suggested",
                    atSec: 146,
                    heard: "pentagon",
                    proposed: "pentaho",
                    confidence: 0.5,
                    rules: [],
                    suggestedAt: now,
                    ...extra,
                },
            ]).items[0]!;
        expect(questionFor(term({}), context())).toBeUndefined();
        expect(questionFor(term({ evidence: { occurrences: 3 } }), context())).toMatchObject({
            about: "term",
            heard: "pentagon",
            choices: ["pentaho"],
            decides: ["i2"],
        });
        expect(questionFor(term({ proposed: "PentahoDI" }), context())).toBeDefined();
    });

    test("neighbours offering the same people become one question, and a shared signature raises its priority", () => {
        const question = (id: string, fromSec: number, choices: string[], confidence: number) => ({
            kind: "question" as const,
            status: "suggested" as const,
            about: "speaker" as const,
            fromSec,
            toSec: fromSec + 10,
            question: "Who?",
            choices,
            decides: [id],
            rules: [],
            confidence,
            signature: choices.join("+"),
            evidence: { words: 20, impact: 4, labels: ["Speaker 5"] },
        });
        const picked = selectQuestions(
            [
                question("i1", 100, ["Bob Example", "Carol Example"], 0.4),
                question("i2", 125, ["Carol Example", "Bob Example"], 0.5),
                question("i3", 400, ["Bob Example", "Carol Example"], 0.5),
                question("i4", 130, ["Dan Example"], 0.5),
            ],
            []
        );
        expect(picked.map((item) => item.decides)).toEqual([["i1", "i2"], ["i4"], ["i3"]]);
        // The cluster: (1 − 0.4) × (4 + log2 2) × 2 questions with its signature.
        expect(picked[0]).toMatchObject({ priority: 6, toSec: 135 });
        expect(picked[1]).toMatchObject({ priority: 2 });
    });

    test("an answer settles the questions with the same signature, and two voices split per line", () => {
        const ask = (id: string, decides: string[]) => ({
            id,
            kind: "question",
            status: "suggested",
            about: "speaker",
            fromSec: 120,
            toSec: 146,
            question: "Who?",
            choices: ["Carol Example", "Bob Example"],
            decides,
            signature: "same",
            rules: [],
            suggestedAt: now,
        });
        const meetingRecord = withItems([
            { ...range, confidence: 0.4 },
            { ...range, id: "i2", fromSec: 300, toSec: 300, confidence: 0.35 },
            ask("i3", ["i1"]),
            ask("i4", ["i2"]),
        ]);
        answerQuestion(meetingRecord, "i3", { answer: "Carol Example", now });
        const question = meetingRecord.items[2]!;
        const settled =
            question.kind === "question"
                ? propagateAnswer(meetingRecord, question, { answer: "Carol Example", listenBelow: 0.6, now })
                : [];
        expect(settled).toEqual(["i4"]);
        expect(meetingRecord.items[1]).toMatchObject({ speaker: "Carol Example", confidence: 0.65 });

        const split = withItems([{ ...range, confidence: 0.4 }, ask("i2", ["i1"])]);
        const lines = splitQuestion(split, "i2", { transcript, now });
        expect(lines.map((item) => [item.fromSec, item.toSec])).toEqual([
            [120, 140],
            [140, 146],
        ]);
        expect(split.items.filter((item) => item.status === "rejected").map((item) => item.id)).toEqual(["i1", "i2"]);
    });

    test("an answer confirms the decided items with it; 'none of these' rejects them", () => {
        const term = {
            id: "i2",
            kind: "term",
            status: "suggested",
            heard: "jenezetka",
            proposed: "JDZ",
            rules: [],
            suggestedAt: now,
        };
        const question = (id: string, decides: string[]) => ({
            id,
            kind: "question",
            status: "suggested",
            about: "speaker",
            fromSec: 120,
            toSec: 146,
            question: "Who?",
            decides,
            rules: [],
            suggestedAt: now,
        });
        const answered = withItems([range, term, question("i3", ["i1", "i2"])]);
        const ledger = answerQuestion(answered, "i3", { answer: "Carol Example", comment: " clear ", now });
        expect(answered.items.map((item) => [item.id, item.status])).toEqual([
            ["i1", "confirmed"],
            ["i2", "confirmed"],
            ["i3", "confirmed"],
        ]);
        expect(answered.items[0]).toMatchObject({ speaker: "Carol Example" });
        expect(answered.items[2]).toMatchObject({ answer: "Carol Example", comment: "clear" });
        expect(ledger).toEqual([expect.objectContaining({ kind: "term", heard: "jenezetka", fixed: "Carol Example" })]);

        const refused = withItems([range, question("i3", ["i1"])]);
        expect(answerQuestion(refused, "i3", { answer: "None of these", now })).toEqual([]);
        expect(refused.items[0]).toMatchObject({ status: "rejected", speaker: "Alice Example" });

        const skipped = withItems([range, question("i3", ["i1"])]);
        skipQuestion(skipped, "i3", now);
        expect(skipped.items.map((item) => item.status)).toEqual(["suggested", "rejected"]);
        expect(openQuestions(skipped)).toEqual([]);
    });
});

describe("several voices", () => {
    test("answering sub-line voices preserves the unresolved range in the rendered transcript", () => {
        const draft = meetingRecordSchema.parse({
            ...record,
            items: [
                {
                    id: "i1",
                    kind: "speaker-range",
                    status: "suggested",
                    label: "Speaker 1",
                    fromSec: 0,
                    toSec: 0,
                    confidence: 0.2,
                    candidates: ["Voice A", "Voice B"],
                    rules: [],
                    suggestedAt: meeting.start,
                },
                {
                    id: "i2",
                    kind: "question",
                    status: "suggested",
                    about: "speaker",
                    fromSec: 0,
                    toSec: 16,
                    question: "Who speaks?",
                    choices: ["Voice A", "Voice B"],
                    decides: ["i1"],
                    rules: [],
                    suggestedAt: meeting.start,
                },
            ],
        });
        const transcript = [line("Speaker 1", 0, "one two three four five six seven eight nine ten")];
        const parts = splitQuestion(draft, "i2", {
            transcript,
            now: meeting.start,
            micShare: (from) => (from < 8 ? 0 : 1),
        });
        expect(parts).toHaveLength(2);
        for (const part of parts) {
            answerQuestion(draft, part.id, { answer: "Voice A", now: meeting.start });
        }
        expect(draft.items[0]?.status).toBe("suggested");
        const corrections = correctionsOf(draft, meetingsConfigSchema.parse({}), {
            withSuggested: true,
            format: "txt",
        });
        expect(corrections.unclear?.passages).toContainEqual(
            expect.objectContaining({ speaker: "Speaker 1", fromSec: 0 })
        );
        const rendered = applyCorrections(transcript, corrections);
        expect(rendered.unclear).toBe(1);
        expect(rendered.entries[0]?.speaker).toContain("Speaker 1");
    });

    const now = "2026-11-02T15:00:00.000Z";
    const question = (fromSec: number, toSec: number) =>
        meetingRecordSchema.parse({
            ...record,
            items: [
                {
                    id: "i1",
                    kind: "question",
                    status: "suggested",
                    about: "speaker",
                    fromSec,
                    toSec,
                    question: "Who says this?",
                    choices: ["Alice Example", "Bob Example"],
                    decides: [],
                    rules: [],
                    suggestedAt: now,
                },
            ],
        });
    // Remote voices until 11 s, then the microphone.
    const micShare = (fromSec: number) => (fromSec >= 11 ? 0.95 : 0.05);

    test("the half-second windows give one run per side, a short flip folded into its neighbour", () => {
        const flip = (fromSec: number) => (fromSec >= 11 ? 0.95 : fromSec >= 5 && fromSec < 5.5 ? 0.5 : 0.05);

        expect(voiceRuns(flip, 0, 16)).toEqual([
            { fromSec: 0, toSec: 11, side: "call" },
            { fromSec: 11, toSec: 16, side: "mic" },
        ]);
    });

    test("one long line is cut where the voice moves to the microphone, each part with its own words and audio", () => {
        const split = question(0, 16);
        const words =
            "jedna dva tři čtyři pět šest sedm osm devět deset jedenáct dvanáct třináct čtrnáct patnáct šestnáct";
        const parts = splitQuestion(split, "i1", { transcript: [line("Alice Example", 0, words)], now, micShare });

        expect(parts.map((part) => [part.fromSec, part.toSec, part.decides])).toEqual([
            [0, 11, []],
            [11, 16, []],
        ]);
        expect(parts[0]!.question).toBe(
            'Who says "jedna dva tři čtyři pět šest sedm osm devět deset jedenáct" (00:00 to 00:11, from the call)?'
        );
        expect(parts[1]!.question).toContain(
            '"dvanáct třináct čtrnáct patnáct šestnáct" (00:11 to 00:16, on your microphone)'
        );
        expect(split.items[0]).toMatchObject({ status: "rejected" });
    });

    test("a question that decides no range is cut at the lines inside it", () => {
        const split = question(10, 20);
        const parts = splitQuestion(split, "i1", {
            transcript: [line("A", 5, "před"), line("A", 10, "první"), line("B", 12, "druhá"), line("A", 20, "po")],
            now,
        });

        expect(parts.map((part) => [part.fromSec, part.toSec])).toEqual([
            [10, 12],
            [12, 20],
        ]);
    });

    test("nothing to cut leaves the question open", () => {
        const split = question(10, 12);
        const parts = splitQuestion(split, "i1", { transcript: [line("A", 10, "jen jedna")], now });

        expect(parts).toEqual([]);
        expect(split.items).toHaveLength(1);
        expect(split.items[0]).toMatchObject({ status: "suggested" });
    });
});

describe("a word question shows where its words are said", () => {
    const now = "2026-11-02T15:00:00.000Z";
    const transcript = [
        line("Alice Example", 50, "Hledal to Petr."),
        line("Alice Example", 55, "Nehodil to někam do Ada, ale nevím vlastně, jestli to našel."),
        line("Bob Example", 70, "Ten username a password do toho Ada, do tý databáze."),
        line("Bob Example", 80, "Jo."),
    ];
    const questions = openQuestions(
        meetingRecordSchema.parse({
            ...record,
            items: [55, 70].map((fromSec, n) => ({
                id: `i${n + 1}`,
                kind: "question",
                status: "suggested",
                about: "term",
                fromSec,
                toSec: fromSec + 10,
                question: 'What is said where the transcript has "Ada"?',
                heard: "Ada",
                choices: ["ADO", "a database name"],
                decides: [],
                rules: [],
                suggestedAt: now,
            })),
        })
    );

    test("the line with the heard words, and the lines before and after it", () => {
        expect(heardContext(questions[0]!, transcript, 240)).toEqual({
            before: "Hledal to Petr.",
            lead: "Nehodil to někam do ",
            heard: "Ada",
            rest: ", ale nevím vlastně, jestli to našel.",
            after: "Ten username a password do toho Ada, do tý databáze.",
        });
    });

    test("two questions on the same word show two different lines", () => {
        const second = heardContext(questions[1]!, transcript, 240);

        expect(second?.lead).toBe("Ten username a password do toho ");
        expect(second?.after).toBe("Jo.");
    });

    test("a long line is cut around the heard words, at whole words", () => {
        const long = [line("Alice Example", 55, `${"slovo ".repeat(40)}do Ada ${"konec ".repeat(40)}`.trim())];
        const context = heardContext(questions[0]!, long, 60);

        expect(context?.heard).toBe("Ada");
        expect(context?.lead.startsWith("…slovo")).toBe(true);
        expect(context?.rest.endsWith("konec…")).toBe(true);
    });
});

describe("the screen at a moment", () => {
    const at = (clock: string) => `2026-11-03T12:${clock}.000Z`;
    const screenRecord = meetingRecordSchema.parse({
        ...record,
        history: [
            { at: at("30:00"), command: "record start", change: "created from Wispr Flow x: 1 lines, 0 people" },
            { at: at("30:00"), command: "record start", change: "display 1" },
            { at: at("40:00"), command: "record stop", change: "3 frames, 1 MB" },
            { at: at("45:00"), command: "record start", change: "display 1" },
            { at: at("50:00"), command: "record stop", change: "1 frames, 1 MB" },
        ],
    });
    const lines = [
        { file: "frames/a.jpg", at: at("30:01"), text: "Figma" },
        { file: "frames/b.jpg", at: at("35:00"), text: "Cursor" },
        { file: "frames/c.jpg", at: at("39:00"), text: "GitLab" },
        { file: "frames/d.jpg", at: at("45:01"), text: "Teams" },
    ];
    const spans = recordedSpans(screenRecord);

    test("the recorded spans come from the history", () => {
        expect(spans).toEqual([
            { fromMs: Date.parse(at("30:00")), toMs: Date.parse(at("40:00")) },
            { fromMs: Date.parse(at("45:00")), toMs: Date.parse(at("50:00")) },
        ]);
    });

    test("with no frame near the moment, the frame still on the screen is shown", () => {
        const { frames, recorded } = framesAt({ lines, spans, targetMs: Date.parse(at("37:00")), windowMs: 10_000 });

        expect(recorded).toBe(true);
        expect(frames).toEqual([{ ...lines[1]!, unchanged: true }]);
    });

    test("a frame near the moment is shown as it is, without the one before", () => {
        const { frames } = framesAt({ lines, spans, targetMs: Date.parse(at("35:02")), windowMs: 10_000 });

        expect(frames).toEqual([lines[1]]);
    });

    test("between two recorded spans nothing was recorded, and no frame is carried over the gap", () => {
        const { frames, recorded } = framesAt({ lines, spans, targetMs: Date.parse(at("42:00")), windowMs: 10_000 });

        expect(recorded).toBe(false);
        expect(frames).toEqual([]);
    });
});

describe("platforms (R3.1)", () => {
    test("every platform has an entry, and a source name finds its platform", () => {
        expect(Object.keys(MEETING_PLATFORMS).sort()).toEqual([...MEETING_PLATFORM_IDS].sort());
        expect(platformOfSourceName("teams")?.id).toBe("teams");
        expect(platformOfSourceName("google_meet")?.id).toBe("google-meet");
        expect(platformOfSourceName("zoom")).toBeUndefined();
    });

    test("E3 reads no speaking readings on a platform without an indicator", () => {
        const evidence = { segments: [], speaking: [{ tSec: 1, speaking: ["Bob Example"], muted: [] }], files: [] };
        const on = (platform?: "teams" | "facetime") =>
            meetingRecordSchema.parse({ ...record, ...(platform ? { platform } : {}) });
        expect(speakingEvidence(on("facetime"), evidence)?.speaking).toEqual([]);
        expect(speakingEvidence(on("teams"), evidence)?.speaking).toHaveLength(1);
        expect(speakingEvidence(on(), evidence)?.speaking).toHaveLength(1);
    });

    test("a Teams attendance file is read onto the transcript clock; a call far away is not this meeting", () => {
        const raw = SafeJSON.stringify([
            {
                meeting: { title: "Planning", startedAt: "2026-11-02T14:00:10.000Z" },
                attendance: [
                    { name: "Bob Example", joinedAt: "2026-11-02T14:01:00.000Z", leftAt: "2026-11-02T14:30:00.000Z" },
                    { name: "alice@example.com", self: true, joinedAt: "2026-11-02T14:00:00.000Z" },
                ],
            },
        ]);
        const loaded = teamsAttendanceFromJson(raw, { title: "Planning", start: meeting.start }, "file");
        expect(loaded?.presence).toEqual([
            { name: "Bob Example", fromSec: 60, toSec: 1800 },
            { name: "alice@example.com", self: true, fromSec: 0, toSec: Number.POSITIVE_INFINITY },
        ]);
        expect(
            teamsAttendanceFromJson(raw, { title: "Planning", start: "2026-11-02T18:00:00.000Z" }, "file")
        ).toBeNull();
    });
});

describe("arrival and muted (R16, RM), Martin's three lines of the example", () => {
    // Invented names; the shape is the example's first 35 s. Fil joins at 12.1 s, Jan only later; the live names say
    // Rob throughout, and Alice (the user) is muted the whole time.
    const people = ["Alice Example", "Bob Example", "Rob Example", "Fil Example"];
    const presence = [
        { name: "Alice Example", self: true, fromSec: 0, toSec: 100 },
        { name: "Bob Example", fromSec: 0, toSec: 100 },
        { name: "Rob Example", fromSec: 0, toSec: 100 },
        { name: "Fil Example", fromSec: 12.1, toSec: 100 },
    ];
    const reading = (tSec: number, speaking: string[]) => ({ tSec, speaking, muted: ["Alice Example"] });
    const items = suggestItems({
        record: meetingRecordSchema.parse({ ...record, participants: [{ name: "Alice Example", self: true }] }),
        meeting: {
            ...meeting,
            transcript: [
                line("Jan Example", 20, "Plus."),
                line("Jan Example", 22, "No musíme to nějak opravit."),
                line("Bob Example", 26, "Jo, to musíme."),
                line("Alice Example", 31, "O co jsem přišel?"),
                line("Bob Example", 34, "Nic moc."),
            ],
        },
        rules: ["evidence"],
        dictionary: { abbrExpansion: "every", entries: [] },
        sourceWords: [],
        presence,
        evidence: {
            selfName: "Alice Example",
            segments: [{ startSec: 19, endSec: 36, channel: "system", liveName: "Rob Example" }],
            speaking: [
                reading(10.6, ["Bob Example"]),
                reading(17.8, ["Bob Example"]),
                reading(20.7, ["Fil Example"]),
                reading(22.5, ["Rob Example"]),
                reading(27, ["Bob Example"]),
                reading(32.7, ["Fil Example"]),
            ],
            files: [],
        },
        now: "2026-11-02T15:00:00.000Z",
    });
    const ranges = items.filter((item) => item.kind === "speaker-range");
    const at = (sec: number) => ranges.filter((item) => item.fromSec === sec);

    test("0:20 'Plus.' is the newcomer: R16 by the first speaking reading, and the live name loses to E3", () => {
        // E3 among those present (0.45) and R16's first reading (0.55) agree: one item, 1 - 0.55 × 0.45 = 0.75.
        expect(at(20)).toEqual([
            expect.objectContaining({ speaker: "Fil Example", rules: ["E1", "E3", "RA", "R16"], confidence: 0.75 }),
        ]);
        expect(at(20).some((item) => item.speaker === "Rob Example")).toBe(false);
    });

    test("0:22 is the live name and the speaking indicator together", () => {
        expect(at(22)).toContainEqual(expect.objectContaining({ speaker: "Rob Example", rules: ["E1", "E3", "E4"] }));
    });

    test("0:31 under the muted user's label is the newcomer's question, and the user is no candidate", () => {
        expect(at(31)).toContainEqual(
            expect.objectContaining({ speaker: "Fil Example", rules: ["R16"], confidence: 0.65 })
        );
        const rm = at(31).find((item) => item.rules.includes("RM"));
        expect(rm).toBeDefined();
        expect(rm?.speaker ?? "").not.toBe("Alice Example");
        expect(rm?.candidates ?? [rm?.speaker]).toEqual(expect.arrayContaining(["Fil Example"]));
        expect(people).toContain("Fil Example");
    });
});

describe("goodbyes that were only an intention", () => {
    const base = {
        record,
        rules: ["speakers" as const],
        dictionary: { abbrExpansion: "every" as const, entries: [] },
        sourceWords: [],
        now: "2026-11-02T15:00:00.000Z",
    };
    // Carol says goodbye at 10 s, nobody but Alice's "Jo, čau." follows, and Carol talks again at 80 s.
    const leaves = (origin: "platform" | "llm") => ({
        ...meeting,
        speakers: meeting.speakers.map((speaker) => (speaker.speakerId === 2 ? { ...speaker, origin } : speaker)),
    });

    test("a platform-named label still in the call splits off no range", () => {
        const presence = [{ name: "Carol Example", fromSec: 0, toSec: 500 }];
        const items = suggestItems({ ...base, meeting: leaves("platform"), presence });
        expect(items.filter((item) => item.kind === "speaker-range" && item.label === "Carol Example")).toEqual([]);
    });

    test("an unanswered goodbye is kept as an intention, never as a question", () => {
        const items = suggestItems({
            ...base,
            meeting: {
                ...leaves("llm"),
                transcript: [
                    line("Alice Example", 0, "Začneme."),
                    line("Carol Example", 10, "Já už musím jít, mějte se."),
                    line(
                        "Carol Example",
                        80,
                        "Tak já pokračuju s databází, ten export dat do nového systému připravíme do pátku."
                    ),
                ],
            },
        });
        const range = items.find((item) => item.kind === "speaker-range" && item.label === "Carol Example");
        expect(range?.evidence).toMatchObject({ intention: true });
        expect(items.some((item) => item.kind === "question")).toBe(false);
    });
});

describe("a term with no spelling yet", () => {
    const now = "2026-11-02T15:00:00.000Z";
    const unknown = {
        id: "i1",
        kind: "term",
        status: "suggested",
        atSec: 12,
        heard: "proklizuje",
        confidence: 0.3,
        rules: [],
        evidence: { occurrences: 2 },
        suggestedAt: now,
    };

    test("is asked as free text, and the answer becomes its spelling", () => {
        const meetingRecord = meetingRecordSchema.parse({ ...record, items: [unknown] });
        const question = questionFor(meetingRecord.items[0]!, { listenBelow: 0.6, transcript: [], points: [] });
        expect(question).toMatchObject({ about: "term", heard: "proklizuje", choices: [] });
        expect(question?.question).toContain('What is "proklizuje"');

        meetingRecord.items.push(meetingItemSchema.parse({ ...question, id: "i2", suggestedAt: now }));
        const ledger = answerQuestion(meetingRecord, "i2", { answer: "prolistuje", now });
        expect(meetingRecord.items[0]).toMatchObject({ status: "confirmed", proposed: "prolistuje" });
        expect(ledger).toEqual([expect.objectContaining({ heard: "proklizuje", fixed: "prolistuje" })]);
    });
});

describe("an agent's findings (items add)", () => {
    const now = "2026-11-02T15:00:00.000Z";

    test("a range and a term carry the agent rule, its confidence and its reason; a question without one is the user's", () => {
        const parsed = findingsFileSchema.parse([
            {
                kind: "speaker-range",
                from: "38:12",
                to: 2300,
                label: "Speaker 5",
                speaker: "Fil Example",
                confidence: 0.85,
                reason: "names Bob in the third person",
            },
            { kind: "term", at: "1:02", heard: "proklizuje", confidence: 0.4, reason: "no dictionary knows it" },
            { kind: "question", from: 10, to: 20, question: "Who?" },
        ]);
        const [range, term, question] = findingItems(parsed, [], now);
        expect(range).toMatchObject({
            id: "i1",
            kind: "speaker-range",
            fromSec: 2292,
            toSec: 2300,
            rules: ["agent"],
            confidence: 0.85,
            evidence: { reason: "names Bob in the third person" },
        });
        expect(term).toMatchObject({ id: "i2", atSec: 62, rules: ["agent"] });
        expect(term).not.toHaveProperty("proposed");
        expect(question).toMatchObject({ id: "i3", kind: "question", rules: ["user"] });
    });

    test("a range or a term without a reason, a bad time, or a question deciding a missing item is refused", () => {
        expect(findingsFileSchema.safeParse([{ kind: "term", at: 5, heard: "x", confidence: 0.5 }]).success).toBe(
            false
        );
        expect(findingsFileSchema.safeParse([{ kind: "question", from: "soon", to: 5, question: "?" }]).success).toBe(
            false
        );
        const [late] = findingsFileSchema.parse({
            findings: [{ kind: "question", from: 5, to: 9, question: "?", decides: ["i9"] }],
        });
        expect(findingProblems([late!], [])[0]).toContain("i9");
    });

    test("a question decides the findings of its own batch by their refs, which become the new ids", () => {
        const parsed = findingsFileSchema.parse([
            { kind: "question", from: 10, to: 20, question: "Who says it?", decides: ["early", "i1"] },
            {
                kind: "speaker-range",
                ref: "early",
                from: 10,
                to: 20,
                label: "Speaker 5",
                speaker: "Fil Example",
                confidence: 0.55,
                reason: "only the content points at him",
            },
            {
                kind: "join",
                at: "2:03",
                label: "Speaker 5",
                joined: "dotáhnu",
                confidence: 0.9,
                reason: "the word is cut",
            },
        ]);
        const existing = meetingItemSchema.parse({
            id: "i1",
            kind: "term",
            status: "suggested",
            heard: "x",
            suggestedAt: now,
        });

        expect(findingProblems(parsed, [existing])).toEqual([]);
        const [question, range, join] = findingItems(parsed, [existing], now);
        expect(question).toMatchObject({ id: "i2", decides: ["i3", "i1"] });
        expect(range).toMatchObject({ id: "i3", kind: "speaker-range" });
        expect(join).toMatchObject({ id: "i4", kind: "join", atSec: 123, speaker: "Speaker 5", joined: "dotáhnu" });
    });

    test("an unknown ref, a ref used twice, or a ref shaped like an item id is refused", () => {
        const range = (ref: string) => ({
            kind: "speaker-range",
            ref,
            from: 1,
            to: 2,
            label: "A",
            speaker: "B",
            confidence: 0.5,
            reason: "r",
        });
        const twice = findingsFileSchema.parse([
            range("a"),
            range("a"),
            { kind: "question", from: 1, to: 2, question: "?", decides: ["b"] },
        ]);

        expect(findingProblems(twice, [])).toEqual([
            expect.stringContaining('ref "a"'),
            expect.stringContaining('ref "a"'),
            expect.stringContaining("decides b"),
        ]);
        expect(findingsFileSchema.safeParse([range("i7")]).success).toBe(false);
    });
});

describe("a term fix for one line, and a word that a question and an unlinked low term both mark", () => {
    const item = (fields: Record<string, unknown>) =>
        meetingItemSchema.parse({ status: "suggested", suggestedAt: "2026-11-02T15:00:00.000Z", ...fields });
    const apply = (items: unknown[], entries: TranscriptEntry[]) =>
        applyCorrections(
            entries,
            correctionsOf(meetingRecordSchema.parse({ ...record, items }), meetingsConfigSchema.parse({}), {
                withSuggested: true,
                dictionary: false,
                format: "txt",
            })
        ).entries.map((entry) => entry.text);

    test("a low-confidence line term leaves the same words elsewhere unmarked", () => {
        const fix = item({
            id: "i1",
            kind: "term",
            atSec: 10,
            heard: "Ada",
            proposed: "ADO",
            scope: "line",
            confidence: 0.2,
            rules: [MeetingRule.Agent],
        });
        const result = apply([fix], [line("A", 0, "Ada řekla ne."), line("A", 10, "Je to v Ada.")]);
        expect(result[0]).toBe("Ada řekla ne.");
        expect(result[1]).not.toBe("Je to v Ada.");
    });

    test("a fix scoped to its line leaves the same words elsewhere as heard", () => {
        const fix = item({
            id: "i1",
            kind: "term",
            atSec: 10,
            heard: "Ada",
            proposed: "ADO",
            scope: "line",
            confidence: 0.9,
            rules: [MeetingRule.Agent],
        });

        expect(apply([fix], [line("A", 0, "Ada řekla ne."), line("A", 10, "Je to v Ada.")])).toEqual([
            "Ada řekla ne.",
            "Je to v ADO.",
        ]);
    });

    test("the question marks the word once, with its own choices", () => {
        const low = item({
            id: "i1",
            kind: "term",
            atSec: 10,
            heard: "vajbu",
            proposed: "vibe",
            confidence: 0.3,
            rules: [MeetingRule.Agent],
        });
        const question = item({
            id: "i2",
            kind: "question",
            about: "term",
            fromSec: 10,
            toSec: 10,
            question: "What is said?",
            heard: "vajbu",
            choices: ["vibe", "vajbu"],
            decides: [],
        });
        const [text] = apply([low, question], [line("A", 10, "To má svou vajbu.")]);

        expect(text).toBe('To má svou [nejasné: "vajbu"; 1) vibe 2) vajbu].');
    });

    test("a range that knows only that the label is wrong marks the line, whatever its confidence", () => {
        const notTheUser = item({
            id: "i1",
            kind: "speaker-range",
            label: "Alice Example",
            fromSec: 10,
            toSec: 10,
            candidates: ["Bob Example", "Carol Example"],
            confidence: 0.6,
            rules: [MeetingRule.Channel],
        });
        const [speaker] = applyCorrections(
            [line("Alice Example", 10, "Ono to...")],
            correctionsOf(
                meetingRecordSchema.parse({ ...record, items: [notTheUser] }),
                meetingsConfigSchema.parse({}),
                {
                    withSuggested: true,
                    dictionary: false,
                    format: "txt",
                }
            )
        ).entries.map((entry) => entry.speaker);

        expect(speaker).toBe('[nejasné: "Alice Example"; 1) Bob Example 2) Carol Example]');
    });
});

describe("evidence --raw", () => {
    test("two lines that start in the same second keep their own text, after an untimed line too", () => {
        const raw = rawMeeting({
            record,
            meeting: {
                ...meeting,
                transcript: [
                    { speaker: "Alice Example", text: "No time on this one." },
                    line("Bob Example", 181, "To právě."),
                    // The same start as the line before: Wispr gives starts in whole seconds.
                    line("Carol Example", 181, "Já ti ho pošlu novej."),
                    line("Bob Example", 185, "Dobře."),
                ],
            },
            evidence: null,
            points: [],
        });
        expect(raw.lines.map((entry) => [entry.label, entry.text])).toEqual([
            ["Bob Example", "To právě."],
            ["Carol Example", "Já ti ho pošlu novej."],
            ["Bob Example", "Dobře."],
        ]);
    });
});

describe("the meetings recorder loop", () => {
    const capture = meetingsConfigSchema.parse({}).global.capture;
    const builtIn: DisplayInfo = {
        id: 1,
        index: 0,
        name: "Built-in",
        main: true,
        widthPt: 1512,
        heightPt: 982,
        scale: 2,
    };
    const external: DisplayInfo = {
        id: 4,
        index: 1,
        name: "External",
        main: false,
        widthPt: 2560,
        heightPt: 1440,
        scale: 1,
    };
    let stores = 0;

    type Step = "frames" | "empty" | "fail" | "hang" | "timeout";

    /** A recorder that follows a script per capture; after the script it waits for the stop the test sends. */
    class ScriptedRecorder extends FrameRecorder {
        readonly id = "native" as const;
        readonly requests: CaptureRequest[] = [];
        /** What the live channel of a running capture was told (`liveControl` scripts only). */
        readonly commands: string[] = [];
        private piece = 0;
        private notified = -1;

        constructor(
            private readonly script: {
                displays: DisplayInfo[][];
                steps: Step[];
                liveControl?: boolean;
                parallel?: boolean;
                /** The live channel also takes settings, mute and a microphone (ax-tool with those commands). */
                liveSettings?: boolean;
                audio?: boolean;
            },
            private readonly whenDone: () => void
        ) {
            super();
        }

        get supports() {
            return {
                followFocus: false,
                displayId: true,
                motionBoxes: false,
                heartbeat: false,
                liveControl: this.script.liveControl === true,
                parallelCaptures: this.script.parallel !== false,
                audio: this.script.audio === true,
            };
        }

        override async audioDevices() {
            return {
                inputs: [
                    { id: "built-in-mic", name: "Built-in Microphone", channels: 1, default: true },
                    { id: "desk-mic", name: "Desk Mic", channels: 1, default: false },
                ],
                outputs: [{ id: "speakers", name: "Speakers", channels: 2, default: true }],
            };
        }

        async available() {
            return { ok: true as const };
        }

        async displays(): Promise<DisplayInfo[]> {
            const index = Math.min(this.piece, this.script.displays.length - 1);
            this.piece += 1;
            return this.script.displays[index] ?? [];
        }

        async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
            this.requests.push(request);
            const step = this.script.steps[this.requests.length - 1] ?? "hang";
            const displayId = request.target.kind === "display" ? request.target.displayId : 0;

            let current = displayId;
            let streamed: string | undefined;

            if (step === "hang" && this.script.liveControl) {
                const path = join(request.outDir, "keep-0001.png");
                streamed = path;
                await Bun.write(path, "png");
                request.hooks?.onLive?.({
                    switchDisplay: async (id) => {
                        this.commands.push(`switch ${id}`);
                        current = id;
                    },
                    pause: () => this.commands.push("pause"),
                    resume: () => this.commands.push("resume"),
                    ...(this.script.liveSettings
                        ? {
                              setRates: async (active: number, idle: number) => {
                                  this.commands.push(`rates ${active} ${idle}`);
                              },
                              setThreshold: async (percent: number) => {
                                  this.commands.push(`threshold ${percent}`);
                              },
                              setMaxLongSide: async (px: number) => {
                                  this.commands.push(`long side ${px}`);
                              },
                              mute: async (source: string, muted: boolean) => {
                                  this.commands.push(`${muted ? "mute" : "unmute"} ${source}`);
                              },
                              setMic: async (deviceId: string) => {
                                  this.commands.push(`mic ${deviceId}`);
                              },
                          }
                        : {}),
                });
                request.hooks?.onFrame?.({ path, atMs: 0, displayId, changePercent: 10, reason: "first" });
            }

            if (step === "hang") {
                if (this.notified !== this.piece) {
                    this.notified = this.piece;
                    this.whenDone();
                }

                await new Promise<void>((resolve) =>
                    signal?.addEventListener("abort", () => resolve(), { once: true })
                );
                const track = request.audio ? join(request.outDir, "audio-mic.m4a") : undefined;

                if (track) {
                    await Bun.write(track, "m4a");
                }

                return {
                    ...(track
                        ? { tracks: [{ source: "mic" as const, path: track, durationMs: 900, mutedSpans: [] }] }
                        : {}),
                    startedAtMs: Date.now(),
                    frames: streamed
                        ? [{ path: streamed, atMs: 0, displayId: current, changePercent: 10, reason: "first" }]
                        : [],
                    endedEarly: "stopped",
                };
            }

            if (step === "fail") {
                throw new CaptureError("failed", "ax-tool capture exited 1: recording never started");
            }

            if (step === "timeout") {
                throw new CaptureError("timeout", "ax-tool capture did not end within 1 s + 30 s");
            }

            if (step === "empty") {
                return { startedAtMs: Date.now(), frames: [] };
            }

            const path = join(request.outDir, "keep-0001.png");
            await Bun.write(path, "png");
            return {
                startedAtMs: Date.now() + this.piece * 1000,
                frames: [{ path, atMs: 0, displayId, changePercent: 10, reason: "first" }],
            };
        }
    }

    async function recordWith(options: {
        displays: DisplayInfo[][];
        steps: Step[];
        failOnJpeg?: boolean;
        beforeJpeg?: (png: string) => Promise<void>;
        ocrBlocks?: Array<{
            text: string;
            confidence: number;
            bounds: { x: number; y: number; width: number; height: number };
        }>;
        liveControl?: boolean;
        liveSettings?: boolean;
        audio?: boolean;
        /** What the test does over the socket at each hanging piece; after the last, it stops the recording. */
        actions?: Array<
            (
                call: (method: string, params?: unknown) => Promise<unknown>,
                live: { id: string; dir: string; folder: string }
            ) => Promise<unknown>
        >;
    }) {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-recorder-${stores}`));
        const created = await store.create(
            { title: "Recorder check", start: "2026-11-03T12:00:00.000Z", createdBy: "record" },
            { command: "record start", change: "created" }
        );
        const liveDir = mkdtempSync(join(tmpdir(), "live-meeting-"));
        const notes: RecorderNote[] = [];
        const seenLive: string[] = [];
        const answers: unknown[] = [];
        const call = (method: string, params?: unknown) =>
            callRecorder({ id: meetingLiveId(created.id), method, params, dir: liveDir }).catch(
                (error: unknown) => error
            );
        const recorder = new ScriptedRecorder(
            {
                displays: options.displays,
                steps: options.steps,
                liveControl: options.liveControl,
                liveSettings: options.liveSettings,
                audio: options.audio,
            },
            () => {
                seenLive.push(...listLiveRecordings(liveDir).map((entry) => `${entry.kind} ${entry.state}`));
                const index = answers.length;
                answers.push(undefined);
                const next = options.actions?.shift() ?? ((send) => send("stop"));
                void next(call, { id: meetingLiveId(created.id), dir: liveDir, folder: store.folder(created.id) }).then(
                    (answer) => {
                        answers[index] = answer;
                    }
                );
            }
        );
        const state = await runRecorder({
            store,
            meetingId: created.id,
            capture,
            ...(options.audio ? { audio: ["mic" as const] } : {}),
            deps: {
                recorder,
                toJpeg: async (_png, jpg) => {
                    await options.beforeJpeg?.(_png);
                    if (options.failOnJpeg) {
                        throw new Error("sips failed for keep-0001.png: disk full");
                    }

                    await Bun.write(jpg, "jpeg");
                },
                ocr: async () => ({
                    text: "Quarterly planning board with several readable lines",
                    blocks: options.ocrBlocks ?? [],
                }),
                notify: async (note) => {
                    notes.push(note);
                },
                liveDir,
                pieceSec: 1,
                failurePauseMs: 0,
            },
        });
        const folder = store.folder(created.id);
        return { store, state, notes, recorder, liveDir, seenLive, answers, folder, saved: store.read(created.id) };
    }

    test("every display at once, named by id; a display that leaves between pieces leaves without an error", async () => {
        const run = await recordWith({
            displays: [[builtIn, external], [builtIn]],
            steps: ["frames", "frames", "frames"],
        });
        const frames = readdirSync(join(run.folder, "frames")).sort();
        const ocr = readFileSync(join(run.folder, "ocr.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((row) => SafeJSON.parse(row, { strict: true }));

        expect(frames.filter((name) => name.endsWith("-d1.jpg"))).toHaveLength(2);
        expect(frames.filter((name) => name.endsWith("-d4.jpg"))).toHaveLength(1);
        expect(ocr.map((line: { displayId: number }) => line.displayId).sort()).toEqual([1, 1, 4]);
        expect(run.recorder.requests.slice(0, 3).map((request) => request.target)).toEqual([
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 4 },
            { kind: "display", displayId: 1 },
        ]);
        expect(run.state.stopReason).toBe("requested");
        expect(run.saved?.recording).toMatchObject({
            status: "stopped",
            stopReason: "requested",
            frames: 3,
            backend: "native",
            displayPolicy: "all",
            displays: [
                { id: 1, name: "Built-in", frames: 2 },
                { id: 4, name: "External", frames: 1 },
            ],
        });
        expect(run.saved?.recording?.spans).toEqual([
            { from: expect.any(String), to: expect.any(String), stopReason: "requested" },
        ]);
        expect(run.notes).toEqual([]);
        expect(run.seenLive).toEqual(["meeting recording"]);
        expect(listLiveRecordings(run.liveDir)).toEqual([]);
        expect(recordingSummary(run.saved!).join("\n")).toContain("Built-in (1) 2, External (4) 1");
    });

    test("each piece's frames land as wall-clock JPEG names with one ocr.jsonl row each before the recording stops", async () => {
        const blocks = [{ text: "Quarterly", confidence: 0.9, bounds: { x: 0.1, y: 0.8, width: 0.3, height: 0.05 } }];
        let midway: { frames: string[]; rows: number } | undefined;
        const run = await recordWith({
            displays: [[builtIn]],
            steps: ["frames", "hang"],
            ocrBlocks: blocks,
            actions: [
                async (send, live) => {
                    midway = {
                        frames: readdirSync(join(live.folder, "frames")),
                        rows: readFileSync(join(live.folder, "ocr.jsonl"), "utf8").trim().split("\n").length,
                    };
                    return send("stop");
                },
            ],
        });
        const frames = readdirSync(join(run.folder, "frames"));
        const rows = readFileSync(join(run.folder, "ocr.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((row) => SafeJSON.parse(row, { strict: true }));

        expect(midway).toEqual({ frames, rows: 1 });
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatch(/^\d{2}-\d{2}-\d{2}-\d{3}-d1\.jpg$/);
        expect(rows).toEqual([
            {
                file: `frames/${frames[0]}`,
                at: expect.any(String),
                displayId: 1,
                changePercent: 10,
                reason: "first",
                text: "Quarterly planning board with several readable lines",
                blocks,
            },
        ]);
        const at = new Date(rows[0].at);
        const pad = (n: number, width = 2) => String(n).padStart(width, "0");
        expect(frames[0]).toBe(
            `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}-d1.jpg`
        );
        expect(run.state.frames).toBe(1);
    });

    test("captures that fail three times stop it as failed, with one notice and the reason in recorder-last.json", async () => {
        const run = await recordWith({ displays: [[builtIn]], steps: ["timeout", "fail", "timeout"] });
        const last = SafeJSON.parse(readFileSync(join(run.folder, "recorder-last.json"), "utf8"), { strict: true });

        expect(run.saved?.recording).toMatchObject({ status: "stopped", stopReason: "failed" });
        expect(run.saved?.recording?.warning).toContain("capture failed 3 times in a row");
        expect(run.saved?.recording?.warning).toContain("No frame was recorded");
        expect(run.saved?.recording?.failureNotifiedAt).toEqual(expect.any(String));
        expect(last).toMatchObject({ stopReason: "failed", warning: expect.stringContaining("did not end within") });
        expect(run.notes.map((note) => note.title)).toEqual(["Screen recording stopped"]);
        expect(run.notes[0]?.message).toContain("record start --meeting");
    });

    test("an error outside the capture still ends the recording, with the reason", async () => {
        const run = await recordWith({ displays: [[builtIn]], steps: ["frames"], failOnJpeg: true });

        expect(run.saved?.recording).toMatchObject({ status: "stopped", stopReason: "error" });
        expect(run.saved?.recording?.warning).toContain("disk full");
        expect(run.notes).toHaveLength(1);
        expect(listLiveRecordings(run.liveDir)).toEqual([]);
    });

    test("a recording without a single frame says so", async () => {
        const run = await recordWith({ displays: [[builtIn]], steps: ["empty"] });

        expect(run.saved?.recording).toMatchObject({ status: "stopped", stopReason: "requested", frames: 0 });
        expect(run.saved?.recording?.warning).toContain("No frame was recorded before the stop");
        expect(recordingSummary(run.saved!)[0]).toContain("no frames");
    });

    test("pause ends a span and resume starts the next; a second pause or a resume while recording is refused", async () => {
        const run = await recordWith({
            displays: [[builtIn]],
            steps: ["frames", "hang", "frames", "hang"],
            actions: [
                async (call) => [
                    await call("pause"),
                    await call("pause"),
                    await Bun.sleep(50),
                    await call("resume"),
                    await call("resume"),
                ],
            ],
        });
        const [paused, again, , resumed, notPaused] = run.answers[0] as unknown[];

        expect(paused).toEqual({ state: "paused" });
        expect(again).toMatchObject({ code: RPC_ERRORS.alreadyPaused });
        expect(resumed).toEqual({ state: "recording" });
        expect(notPaused).toMatchObject({ code: RPC_ERRORS.notPaused });
        expect(run.saved?.recording?.spans?.map((span) => span.stopReason)).toEqual(["paused", "requested"]);
        expect(readdirSync(join(run.folder, "frames"))).toHaveLength(2);
    });

    test("a display switch applies at once, and an unknown display is refused", async () => {
        const run = await recordWith({
            displays: [[builtIn, external]],
            steps: ["hang", "hang", "frames", "hang"],
            actions: [
                async (call) => [
                    await call("displays.list"),
                    await call("displays.switch", { displayId: 9 }),
                    await call("displays.switch", { displayId: 4 }),
                ],
            ],
        });
        const [listed, unknown, switched] = run.answers[0] as unknown[];

        expect(listed).toEqual([
            expect.objectContaining({ id: 1, recorded: true }),
            expect.objectContaining({ id: 4, recorded: true }),
        ]);
        expect(unknown).toMatchObject({ code: RPC_ERRORS.unknownDisplay });
        expect(switched).toEqual({ mode: "all", chosen: [4], applied: "restart" });
        expect(readdirSync(join(run.folder, "frames"))).toEqual([expect.stringMatching(/-d4\.jpg$/)]);
        expect(run.recorder.requests.at(-1)?.target).toEqual({ kind: "display", displayId: 4 });
    });

    test("with a live channel, a switch and a pause go to the running capture, and frames count as they land", async () => {
        const run = await recordWith({
            displays: [[builtIn, external]],
            steps: ["hang", "hang"],
            liveControl: true,
            actions: [
                async (call) => {
                    const frames = ((await call("status")) as { frames: number }).frames;
                    return [
                        frames,
                        await call("displays.remove", { displayId: 4 }),
                        await call("displays.switch", { displayId: 4 }),
                        await call("pause"),
                        await call("resume"),
                        await call("stop"),
                    ];
                },
            ],
        });
        const [framesLive, removed, switched] = run.answers[0] as unknown[];

        expect(framesLive).toBe(2);
        expect(removed).toMatchObject({ applied: "stopped", chosen: [1] });
        expect(switched).toMatchObject({ applied: "live", chosen: [4] });
        expect(run.recorder.commands).toEqual(["switch 4", "pause", "resume"]);
        // No restart: the first two captures were the only ones before the stop.
        expect(run.recorder.requests.map((request) => request.target)).toEqual([
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 4 },
        ]);
        expect(run.saved?.recording?.spans?.map((span) => span.stopReason)).toEqual(["paused", "requested"]);
        expect(readdirSync(join(run.folder, "frames")).sort()).toEqual([
            expect.stringMatching(/-d4\.jpg$/),
            expect.stringMatching(/-d4\.jpg$/),
        ]);
    });

    test("switching onto a recorded display waits for its displaced capture processing", async () => {
        const displaced = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const run = await recordWith({
            displays: [[builtIn, external]],
            steps: ["hang", "hang"],
            liveControl: true,
            beforeJpeg: async (png) => {
                if (png.includes("/d4-")) {
                    displaced.resolve();
                    await withTimeout(release.promise, 2_000);
                    expect(existsSync(png)).toBe(true);
                }
            },
            actions: [
                async (call) => {
                    await call("displays.switch", { displayId: 4 });
                    await withTimeout(displaced.promise, 2_000);
                    const stopped = call("stop");
                    try {
                        expect(
                            await Promise.race([stopped.then(() => "stopped"), Bun.sleep(100).then(() => "waiting")])
                        ).toBe("waiting");
                    } finally {
                        release.resolve();
                    }
                    return stopped;
                },
            ],
        });
        expect(readdirSync(join(run.folder, "frames"))).toHaveLength(2);
    });

    test("removing the audio owner restarts audio on the remaining display", async () => {
        const run = await recordWith({
            displays: [[builtIn, external]],
            steps: ["hang", "hang", "hang"],
            audio: true,
            actions: [async (call) => call("displays.remove", { displayId: 1 })],
        });
        expect(run.answers[0]).toMatchObject({ applied: "restart", chosen: [4] });
        expect(run.recorder.requests.at(-1)).toMatchObject({
            target: { kind: "display", displayId: 4 },
            audio: { sources: ["mic"] },
        });
    });

    test("disabling heartbeat passes zero to the restarted capture", async () => {
        const run = await recordWith({
            displays: [[builtIn]],
            steps: ["hang", "hang", "hang"],
            actions: [
                async (call) => call("settings.set", { heartbeatSec: 10 }),
                async (call) => call("settings.set", { heartbeatSec: 0 }),
            ],
        });
        expect(run.recorder.requests.at(-1)?.heartbeatSec).toBe(0);
        expect(run.recorder.requests.some((request) => request.heartbeatSec === 10)).toBe(true);
    });

    test("a display added in mode all starts its capture at once, inside the running piece", async () => {
        const run = await recordWith({
            displays: [[builtIn, external]],
            steps: ["hang", "hang"],
            actions: [
                async (call) => [
                    await call("displays.remove", { displayId: 4 }),
                    await call("displays.add", { displayId: 4 }),
                ],
            ],
        });
        const [removed, added] = run.answers[0] as unknown[];

        expect(removed).toMatchObject({ applied: "stopped" });
        expect(added).toMatchObject({ applied: "started", chosen: [1, 4] });
        expect(run.recorder.requests.map((request) => request.target)).toEqual([
            { kind: "display", displayId: 1 },
            { kind: "display", displayId: 4 },
            { kind: "display", displayId: 4 },
        ]);
    });

    test("settings change live through the running capture, or restart it when it has no such command", async () => {
        const live = await recordWith({
            displays: [[builtIn]],
            steps: ["hang", "hang"],
            liveControl: true,
            liveSettings: true,
            actions: [
                async (call) => [
                    await call("settings.set", { activeFps: 2, idleFps: 0.5, threshold: 3 }),
                    await call("settings.set", { ocr: { minChars: 5 } }),
                    await call("settings.set", { activeFps: 999 }),
                    await call("settings.get"),
                    await call("stop"),
                ],
            ],
        });
        const [changed, ocrOnly, refused, read] = live.answers[0] as Array<{
            applied?: string;
            settings?: { ocr: { minChars: number } };
        }>;

        expect(changed).toMatchObject({ applied: "live", settings: { activeFps: 2, idleFps: 0.5, threshold: 3 } });
        expect(ocrOnly?.applied).toBe("next-piece");
        expect(refused).toMatchObject({ code: RPC_ERRORS.invalidParams });
        expect(read?.settings?.ocr.minChars).toBe(5);
        expect(live.recorder.commands).toEqual(["rates 2 0.5", "threshold 3"]);
        expect(live.recorder.requests).toHaveLength(1);

        const restarted = await recordWith({
            displays: [[builtIn]],
            steps: ["hang", "hang"],
            actions: [async (call) => await call("settings.set", { activeFps: 2 })],
        });

        expect(restarted.answers[0]).toMatchObject({ applied: "restart" });
        expect(restarted.recorder.requests.map((request) => request.activeFps)).toEqual([1, 2]);
    });

    test("sound: mute and a microphone switch go to the running capture, its file lands in audio/, and progress reaches a subscriber", async () => {
        const progress: string[] = [];
        const run = await recordWith({
            displays: [[builtIn, external]],
            steps: ["hang", "hang"],
            liveControl: true,
            liveSettings: true,
            audio: true,
            actions: [
                async (call, live) => {
                    const client = await RecorderClient.connect(live.id, { dir: live.dir });
                    await client.subscribe(
                        (event) => {
                            const params = event.params as { step?: string; done?: number; total?: number };
                            progress.push(`${params.step} ${params.done}/${params.total}`);
                        },
                        ["progress"]
                    );
                    const answers = [
                        await call("audio.list"),
                        await call("audio.mute", { source: "mic", muted: true }),
                        await call("audio.mute", { source: "system", muted: true }),
                        await call("audio.setInput", { deviceId: "nope" }),
                        await call("audio.setInput", { deviceId: "desk-mic" }),
                        await client.stop(),
                    ];
                    client.close();
                    return answers;
                },
            ],
        });
        const [devices, muted, notRecorded, unknown, switched, stopped] = run.answers[0] as unknown[];

        expect(devices).toMatchObject({ inputs: [{ id: "built-in-mic" }, { id: "desk-mic" }] });
        expect(muted).toMatchObject({ sources: ["mic"], muted: { mic: true, system: false } });
        expect(notRecorded).toMatchObject({ code: RPC_ERRORS.invalidParams });
        expect(unknown).toMatchObject({ code: RPC_ERRORS.unknownDevice });
        expect(switched).toMatchObject({ micDevice: "desk-mic" });
        expect(stopped).toMatchObject({
            state: "stopped",
            outcome: "requested",
            job: expect.stringMatching(/^finish-/),
        });
        expect(run.recorder.commands).toEqual(["mute mic", "mic desk-mic"]);
        // Only the first capture records the sound.
        expect(run.recorder.requests.map((request) => Boolean(request.audio))).toEqual([true, false]);
        expect(readdirSync(join(run.folder, "audio"))).toEqual([expect.stringMatching(/-d1-mic\.m4a$/)]);
        expect(readFileSync(join(run.folder, "audio.jsonl"), "utf8")).toContain('"source":"mic"');
        expect(run.saved?.recording).toMatchObject({ audio: { sources: ["mic"], files: 1 } });
        expect(progress).toEqual(expect.arrayContaining(["summary 1/1", "collect 3/3"]));
    });
});

describe("the screen at a moment, per display", () => {
    const at = (clock: string) => `2026-11-03T12:${clock}.000Z`;
    const lines = [
        { file: "frames/a-d1.jpg", at: at("30:01"), displayId: 1, text: "Figma" },
        { file: "frames/b-d4.jpg", at: at("31:00"), displayId: 4, text: "Teams" },
        { file: "frames/c-d1.jpg", at: at("35:00"), displayId: 1, text: "Cursor" },
    ];
    const spans = [{ fromMs: Date.parse(at("30:00")), toMs: Date.parse(at("40:00")) }];

    test("each display shows the frame still on its own screen", () => {
        const { displays, recorded } = framesAtPerDisplay({
            lines,
            spans,
            targetMs: Date.parse(at("36:00")),
            windowMs: 10_000,
        });

        expect(recorded).toBe(true);
        expect(displays).toEqual([
            { displayId: 1, frames: [{ ...lines[2]!, unchanged: true }] },
            { displayId: 4, frames: [{ ...lines[1]!, unchanged: true }] },
        ]);
    });

    test("the spans the recorder keeps win; pauses are gaps", () => {
        const paused = meetingRecordSchema.parse({
            ...record,
            recording: {
                status: "stopped",
                spans: [
                    { from: at("30:00"), to: at("33:00"), stopReason: "paused" },
                    { from: at("34:00"), to: at("40:00"), stopReason: "requested" },
                ],
            },
        });

        expect(recordedSpans(paused)).toEqual([
            { fromMs: Date.parse(at("30:00")), toMs: Date.parse(at("33:00")) },
            { fromMs: Date.parse(at("34:00")), toMs: Date.parse(at("40:00")) },
        ]);
    });

    test("a recording block from before the schema still reads", () => {
        const old = meetingRecordSchema.parse({
            ...record,
            recording: {
                startedAt: at("30:00"),
                display: 1,
                framesDir: "frames",
                ocr: "ocr.jsonl",
                status: "stopped",
                stopReason: "failed",
                frames: 12,
                bytes: 2_000_000,
                somethingElse: true,
            },
        });

        expect(old.recording).toMatchObject({ display: 1, frames: 12, somethingElse: true });
        expect(recordingSummary(old)[0]).toContain("stopped (failed), 12 frames");
    });
});

describe("a recorder that records one display at a time", () => {
    const displays = [
        { id: 4, index: 1, name: "External", main: false, widthPt: 2560, heightPt: 1440, scale: 1 },
        { id: 1, index: 0, name: "Built-in", main: true, widthPt: 1512, heightPt: 982, scale: 2 },
    ];

    test("all keeps only the main display and says so; a recorder with parallel captures keeps both", () => {
        const single = pieceTargets({ policy: "all", displays, followFocus: false, parallel: false });
        const both = pieceTargets({ policy: "all", displays, followFocus: false, parallel: true });

        expect(single.targets.map((target) => target.displayId)).toEqual([1]);
        expect(single.fallback).toContain("one display at a time");
        expect(both.targets.map((target) => target.displayId)).toEqual([4, 1]);
        expect(both.fallback).toBeUndefined();
    });
});

test("a stale recorder claim is recovered and an initialization failure releases it", async () => {
    const store = new MeetingStore(new Storage("recorder-claim-regression"));
    const record = await store.create(
        { title: "Claim fixture", start: meeting.start, createdBy: "new" },
        { command: "test", change: "fixture" }
    );
    const files = recorderFiles(store);
    writePidFile(files.pid, { pid: 99999999 });
    writeFileSync(join(store.folder(record.id), "frames"), "blocks the frames directory");
    await expect(
        runRecorder({ store, meetingId: record.id, capture: meetingsConfigSchema.parse({}).global.capture })
    ).rejects.toThrow();
    expect(existsSync(files.pid)).toBe(false);
});

describe("transcriptDocument", () => {
    const stamped = meetingRecordSchema.parse({
        ...record,
        title: "Změny ve wiki: zadání",
        project: "shop",
        sources: { wisprflow: { id: "x" }, teams: {} },
    });
    const turns = groupTurns([
        line("Alice Example", 0, "Ahoj, začneme."),
        line("Alice Example", 40, "Druhý odstavec <sup>(`/{type}`)</sup>."),
        line("Bob Example", 100, "Tak čtu:\n\n> Kap. 2. <sup>(čte z Notes, ř. 4)</sup>\n\n, [nejasné: kdo?] konec."),
    ]);
    const options = {
        speakers: [
            { name: "Alice Example", lines: 2 },
            { name: "Bob Example", lines: 1 },
        ],
        unattributed: [{ name: "Speaker 5", lines: 1 }],
        frontmatter: true,
        timestamps: true,
    };

    test("golden: front matter, the title, and the turns with clocks, play links, meanings, quotes and marks", () => {
        const md = transcriptDocument({
            ...options,
            record: stamped,
            turns,
            playLink: (sec) => `https://example.com/p?at=${sec}`,
        });

        expect(md).toBe(
            [
                "---",
                'title: "Změny ve wiki: zadání"',
                "meeting: 2026-11-02 14:00",
                "project: shop",
                "meeting_id: 2026-11-02_15-00-planning",
                "sources:",
                "  - wisprflow",
                "  - teams",
                "speakers:",
                "  Alice Example: 2",
                "  Bob Example: 1",
                "unattributed:",
                "  Speaker 5: 1",
                "---",
                "",
                "# Změny ve wiki: zadání",
                "",
                "**Alice Example:** `00:00`<sup>[play](https://example.com/p?at=0)</sup> Ahoj, začneme.",
                "",
                "`00:40`<sup>[play](https://example.com/p?at=40)</sup> Druhý odstavec <sup>(`/{type}`)</sup>.",
                "",
                "**Bob Example:** `01:40`<sup>[play](https://example.com/p?at=100)</sup> Tak čtu:",
                "",
                "> Kap. 2. <sup>(čte z Notes, ř. 4)</sup>",
                "",
                ", [nejasné: kdo?] konec.",
                "",
            ].join("\n")
        );
    });

    test("golden: no front matter, no clocks, and an untitled meeting", () => {
        const md = transcriptDocument({
            ...options,
            record: { ...stamped, title: "" },
            turns,
            frontmatter: false,
            timestamps: false,
        });

        expect(md).toBe(
            [
                "# Untitled meeting",
                "",
                "**Alice Example:** Ahoj, začneme.",
                "",
                "Druhý odstavec <sup>(`/{type}`)</sup>.",
                "",
                "**Bob Example:** Tak čtu:",
                "",
                "> Kap. 2. <sup>(čte z Notes, ř. 4)</sup>",
                "",
                ", [nejasné: kdo?] konec.",
                "",
            ].join("\n")
        );
    });

    test("golden: a meeting with no turns ends after the title (it used to leave two blank lines)", () => {
        const md = transcriptDocument({
            ...options,
            unattributed: [],
            record: { ...stamped, project: undefined },
            turns: [],
            timestamps: false,
        });

        expect(md).toBe(
            [
                "---",
                'title: "Změny ve wiki: zadání"',
                "meeting: 2026-11-02 14:00",
                "meeting_id: 2026-11-02_15-00-planning",
                "sources:",
                "  - wisprflow",
                "  - teams",
                "speakers:",
                "  Alice Example: 2",
                "  Bob Example: 1",
                "---",
                "",
                "# Změny ve wiki: zadání",
                "",
            ].join("\n")
        );
    });
});

describe("showText", () => {
    test("golden: the facts, context, renames and history of a full record (a blank line now follows each heading)", () => {
        const full = meetingRecordSchema.parse({
            ...record,
            project: "shop",
            end: "2026-11-02T14:45:00.000Z",
            sources: { wisprflow: { id: "w1" } },
            calendar: { from: "apple-calendar", title: "Plánování", attendees: ["Alice", "Bob"] },
            participants: [
                { name: "Alice Example", self: true, from: [] },
                { name: "Bob Example", from: [] },
            ],
            context: [
                {
                    id: "c1",
                    kind: "file",
                    ref: "/tmp/spec.md",
                    title: "Spec",
                    note: "the brief",
                    addedAt: "2026-11-02T14:00:00.000Z",
                    addedBy: "user",
                },
                { id: "c2", kind: "note", ref: "x".repeat(100), addedAt: "2026-11-02T14:00:00.000Z", addedBy: "user" },
            ],
            speakers: { labels: { "Speaker 5": "Carol Example" } },
            recording: {
                status: "stopped",
                frames: 12,
                bytes: 2048,
                backend: "sck",
                displays: [{ id: 1, name: "Built-in", frames: 12 }],
                warning: "disk low",
            },
            history: [{ at: "2026-11-02T14:50:00.000Z", command: "set", change: "project shop" }],
        });

        expect(showText(full)).toBe(
            [
                "# Planning",
                "",
                "- id: 2026-11-02_15-00-planning",
                "- when: 2026-11-02 14:00–14:45",
                "- project: shop",
                '- wisprflow: {"id":"w1"}',
                "- calendar (apple-calendar): Plánování, 2 invited",
                "- people: Alice Example (you), Bob Example",
                "- recording: stopped, 12 frames, 2.0 KB, sck",
                "- displays: Built-in (1) 12",
                "- recording warning: disk low",
                "",
                "## Context",
                "",
                "- c1 file: Spec: /tmp/spec.md (the brief)",
                `- c2 note: ${"x".repeat(79)}…`,
                "",
                "## Speaker renames",
                "",
                "- Speaker 5 → Carol Example",
                "",
                "## History",
                "",
                "- 2026-11-02 14:50 set: project shop",
                "",
            ].join("\n")
        );
    });

    test("golden: a bare record names the command that sets its project, and has an empty history", () => {
        expect(showText(record)).toBe(
            [
                "# Planning",
                "",
                "- id: 2026-11-02_15-00-planning",
                "- when: 2026-11-02 14:00",
                "- project: none (set it: tools meetings set 2026-11-02_15-00-planning --project <name>)",
                "",
                "## History",
                "",
            ].join("\n")
        );
    });

    test("a record with labels lists them after its project", () => {
        const labelled = meetingRecordSchema.parse({ ...record, project: "shop", labels: ["Checkout", "Q4 plan"] });

        expect(showText(labelled).split("\n").slice(4, 6)).toEqual(["- project: shop", "- labels: Checkout, Q4 plan"]);
    });
});

describe("screen boxes", () => {
    test("draws what changed since the display's earlier frame, or what matches, and crops each box", async () => {
        const folder = mkdtempSync(join(tmpdir(), "meeting-boxes-"));
        mkdirSync(join(folder, "frames"));
        const canvas = createCanvas(400, 200);
        canvas.getContext("2d").fillRect(0, 0, 400, 200);

        for (const name of ["a-d1.png", "b-d1.png"]) {
            writeFileSync(join(folder, "frames", name), canvas.toBuffer("image/png"));
        }

        const block = (text: string, x: number, y: number) => ({
            text,
            confidence: 1,
            bounds: { x: String(x), y: String(y), width: "0.25", height: "0.1" },
        });
        const rows = [
            {
                file: "frames/a-d1.png",
                at: "2026-11-04T15:00:00.000Z",
                displayId: 1,
                text: "Quick views",
                blocks: [block("Quick views", 0.1, 0.8)],
            },
            {
                file: "frames/b-d1.png",
                at: "2026-11-04T15:00:05.000Z",
                displayId: 1,
                text: "OuIck VewS\nTask 3",
                blocks: [block("OuIck VewS", 0.1, 0.8), block("Task 3", 0.6, 0.2)],
            },
        ];
        const outDir = join(folder, "out");
        const changed = await renderScreenBoxes({ folder, rows, files: ["frames/b-d1.png"], level: "line", outDir });

        expect(changed).toEqual([
            {
                file: "frames/b-d1.png",
                at: "2026-11-04T15:00:05.000Z",
                displayId: 1,
                selection: "changed",
                width: 400,
                height: 200,
                boxes: [{ text: "Task 3", confidence: 1, x: 240, y: 140, width: 100, height: 20 }],
                annotated: join(outDir, "b-d1.boxes.png"),
                crops: [join(outDir, "b-d1.1.png")],
            },
        ]);
        const crop = SafeJSON.stringify(
            checkImageDimensions({ data: readFileSync(changed[0].crops[0]), maxPixels: 1e6 })
        );
        expect(crop).toBe(SafeJSON.stringify({ width: 124, height: 44 }));

        const matched = await renderScreenBoxes({
            folder,
            rows,
            files: ["frames/b-d1.png"],
            match: "quick",
            level: "block",
            outDir,
        });
        expect(matched[0]?.boxes.map((box) => box.text)).toEqual([]);
        const exact = await renderScreenBoxes({
            folder,
            rows,
            files: ["frames/a-d1.png"],
            match: "QUICK",
            level: "block",
            outDir,
        });
        expect(exact[0]?.boxes.map((box) => box.text)).toEqual(["Quick views"]);
        expect(
            framesMatching(
                rows.map((row) => ocrRowSchema.parse(row)),
                "task",
                5
            ).map((row) => row.file)
        ).toEqual(["frames/b-d1.png"]);
    });
});

describe("a meeting recording as an editor project", () => {
    test("transcript lines become captions with the speaker on the recording's clock; a line said into the start stays, one after the end goes", () => {
        const zeroMs = Date.parse("2026-11-04T15:00:00.000Z");
        const segments = captionSegments({
            entries: [
                { speaker: "Alice", text: "before the recording", startSec: 2 },
                { speaker: "Alice", text: "Hello", startSec: 10 },
                { speaker: "Bob", text: " Hi there ", startSec: 14 },
                { speaker: "Bob", text: "no time" },
                { speaker: "Alice", text: "a long one", startSec: 40 },
                { speaker: "Alice", text: "after the end", startSec: 200 },
            ],
            zeroMs,
            startedMs: zeroMs + 8_000,
            durationSec: 60,
        });

        expect(segments).toEqual([
            { text: "Alice: before the recording", start: 0, end: 2, speaker: "Alice" },
            { text: "Alice: Hello", start: 2, end: 6, speaker: "Alice" },
            { text: "Bob: Hi there", start: 6, end: 18, speaker: "Bob" },
            { text: "Alice: a long one", start: 32, end: 44, speaker: "Alice" },
        ]);
    });
});
