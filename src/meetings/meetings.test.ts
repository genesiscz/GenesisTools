import { describe, expect, test } from "bun:test";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { suggestDictionary } from "./lib/dictionary-suggest";
import { suggestItems } from "./lib/suggest";
import { type WatchDeps, watchOnce } from "./lib/watch";

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
                evidence: expect.objectContaining({ note: expect.stringContaining("listening") }),
            }),
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
            notify: async (title) => {
                notes.push(title);
            },
            ...over,
        };
        return { store: new MeetingStore(new Storage(`meetings-watch-${stores}`)), deps, runs, notes };
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
        const agrees = suggestItems({ ...base, meeting: oneLine, evidence, energyLeftShare: () => 0.9 });
        const loud = suggestItems({ ...base, meeting: oneLine, evidence, energyLeftShare: () => 0.5 });

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
                rules: ["dictionary-fuzzy"],
            })
        );
    });
});
