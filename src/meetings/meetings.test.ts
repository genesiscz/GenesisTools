import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MEETING_PLATFORM_IDS } from "@genesiscz/utils/meetings/platform";
import { MeetingStore, meetingItemSchema, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import { applyCorrections } from "@genesiscz/utils/transcribe/apply";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { suggestDictionary } from "./lib/dictionary-suggest";
import { findingItems, findingProblem, findingsFileSchema } from "./lib/findings";
import { MEETING_PLATFORMS, platformOfSourceName, speakingEvidence } from "./lib/platforms";
import { teamsAttendanceFromJson } from "./lib/platforms/teams";
import { selectQuestions } from "./lib/question-select";
import {
    answerQuestion,
    openQuestions,
    propagateAnswer,
    type QuestionContext,
    questionFor,
    skipQuestion,
    splitQuestion,
} from "./lib/questions";
import { rawMeeting } from "./lib/raw";
import { suggestItems } from "./lib/suggest";
import { correctionsOf } from "./lib/transcript-corrections";
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
        let running = false;
        const deps: Partial<WatchDeps> = {
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
        return { store: new MeetingStore(new Storage(`meetings-watch-${stores}`)), deps, runs, notes, posted };
    }

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
        const agrees = suggestItems({ ...base, meeting: oneLine, evidence, energyMicShare: () => 0.9 });
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
        const presence = [
            { name: "Bob Example", fromSec: 0, toSec: 200 },
            { name: "alice@example.com", self: true, fromSec: 0, toSec: 200 },
            { name: "Dan Example", fromSec: 150, toSec: 200 },
        ];
        expect(questionFor(parsed, context({ presence, selfName: "Alice Example" }))).toMatchObject({
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
        expect(findingProblem(late!, [])).toContain("i9");
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
