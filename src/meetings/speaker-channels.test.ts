import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { silentCallSpans } from "@genesiscz/utils/meetings/energy";
import { meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { teamsAttendanceFromJson } from "./lib/platforms/teams";
import { suggestItems } from "./lib/suggest";
import { clearLanguage, lineLanguages } from "./lib/word-languages";

const USER = "Una Example";
const START = "2026-11-03T12:00:00.000Z";
const record = meetingRecordSchema.parse({
    id: "2026-11-03_13-00-room",
    title: "Room",
    start: START,
    createdAt: START,
    createdBy: "new",
    participants: [{ name: USER, self: true, from: ["wisprflow"] }],
});
const base = {
    record,
    rules: ["evidence" as const],
    dictionary: { abbrExpansion: "every" as const, entries: [] },
    sourceWords: [],
    now: START,
};

interface Slot {
    label: string;
    /** The microphone's share of the energy in the slot. */
    mic: number;
}

/** One 10 s line per slot, with a live segment and an energy share that follow the slot. */
function scene(slots: Slot[]): {
    meeting: SourceMeeting;
    evidence: MeetingEvidence;
    share: (fromSec: number, toSec: number) => number | undefined;
} {
    const transcript: TranscriptEntry[] = slots.map((slot, index) => ({
        speaker: slot.label,
        startSec: index * 10,
        text: `Věta číslo ${index}.`,
    }));
    const meeting: SourceMeeting = {
        sourceMeetingId: "room",
        title: "Room",
        start: START,
        participants: [],
        speakers: [
            { speakerId: 1, name: "Bob Example", origin: "platform" },
            { speakerId: 2, name: "Carol Example", origin: "platform" },
        ],
        transcript,
        folders: [],
    };
    const evidence: MeetingEvidence = {
        selfName: USER,
        segments: slots.map((slot, index) => ({
            startSec: index * 10,
            endSec: index * 10 + 10,
            channel: slot.mic >= 0.5 ? ("mic" as const) : ("system" as const),
        })),
        speaking: [],
        files: [],
    };
    const share = (fromSec: number) => slots[Math.floor(fromSec / 10)]?.mic;

    return { meeting, evidence, share };
}

const ranges = (items: ReturnType<typeof suggestItems>) => items.filter((item) => item.kind === "speaker-range");

describe("a call channel that stays silent (the call played through the room)", () => {
    test("silentCallSpans finds 5 min or more where the microphone holds all the speech", () => {
        const share = (fromSec: number) => (fromSec < 600 ? 1 : fromSec % 10 < 5 ? 0.95 : 0.02);

        expect(silentCallSpans(share, 0, 1200)).toEqual([{ fromSec: 0, toSec: 600 }]);
        expect(silentCallSpans(() => 1, 0, 240)).toEqual([]);
    });

    test("E1 says nothing there; the microphone's label from where the channels work stands for the user (R19)", () => {
        const silent: Slot[] = Array.from({ length: 60 }, (_, index) => ({
            label: index % 2 === 0 ? "Bob Example" : "Carol Example",
            mic: 1,
        }));
        const working: Slot[] = Array.from({ length: 60 }, (_, index) => ({
            label: index % 2 === 0 ? "Bob Example" : "Carol Example",
            mic: index % 2 === 0 ? 0.95 : 0.02,
        }));
        const { meeting, evidence, share } = scene([...silent, ...working]);
        const found = ranges(suggestItems({ ...base, meeting, evidence, energyMicShare: share }));

        expect(found.filter((item) => item.label === "Carol Example")).toEqual([]);
        expect(found.find((item) => item.fromSec === 0)).toMatchObject({
            label: "Bob Example",
            speaker: USER,
            rules: ["R19"],
            confidence: 0.5,
        });
        expect(found.find((item) => item.fromSec === 600)).toMatchObject({ speaker: USER, rules: ["E1", "energy"] });
    });
});

describe("a second person in the room on the user's microphone (R18)", () => {
    const pattern: Slot[] = [
        { label: "Bob Example", mic: 0.95 },
        { label: "Bob Example", mic: 0.95 },
        { label: "Carol Example", mic: 0.95 },
        { label: "Carol Example", mic: 0.02 },
    ];
    const { meeting, evidence, share } = scene(Array.from({ length: 30 }, () => pattern).flat());
    const presence = ["Bob Example", "Carol Example", "Dan Example"].map((name) => ({
        name,
        fromSec: 0,
        toSec: 1200,
    }));
    const found = ranges(suggestItems({ ...base, meeting, evidence, energyMicShare: share, presence }));

    test("the other label's microphone lines are not the user's: the people in the call are asked for", () => {
        const carol = found.filter((item) => item.label === "Carol Example");

        expect(carol.length).toBeGreaterThan(0);
        expect(carol.every((item) => item.speaker === undefined && item.rules.includes("R18"))).toBe(true);
        expect(carol[0]).toMatchObject({
            confidence: 0.4,
            candidates: ["Bob Example", "Carol Example", "Dan Example"],
        });
    });

    test("the larger microphone voice stays the user's, at most 0.7", () => {
        const bob = found.filter((item) => item.label === "Bob Example");

        expect(bob.length).toBeGreaterThan(0);
        expect(bob.every((item) => item.speaker === USER && (item.confidence ?? 1) <= 0.7)).toBe(true);
    });
});

describe("Teams attendance without join or leave times", () => {
    test("everyone the call-ended message lists is present for the whole call, and the note says so", () => {
        const raw = SafeJSON.stringify([
            {
                meeting: {
                    title: "Room",
                    startedAt: "2026-11-03T11:58:00.000Z",
                    endedAt: "2026-11-03T13:00:00.000Z",
                },
                attendance: [
                    { name: "Bob Example", joinedAt: null, leftAt: null },
                    { name: "una@example.com", self: true, joinedAt: null, leftAt: null },
                ],
            },
        ]);
        const loaded = teamsAttendanceFromJson(raw, { title: "Room", start: START }, "file");

        expect(loaded?.presence).toEqual([
            { name: "Bob Example", fromSec: -120, toSec: 3600 },
            { name: "una@example.com", self: true, fromSec: -120, toSec: 3600 },
        ]);
        expect(loaded?.note).toContain("2 without join or leave times");
    });

    test("a call that lists nobody says so", () => {
        const raw = SafeJSON.stringify([{ meeting: { title: "Room", startedAt: START }, attendance: [] }]);

        expect(teamsAttendanceFromJson(raw, { title: "Room", start: START }, "file")?.note).toContain(
            "no participant list"
        );
    });
});

describe("the language of a line", () => {
    test("Slovak and Czech marker words and letters decide a clear line", () => {
        expect(clearLanguage("Ja si myslím, že to je proste nejaký problém, lebo sa to nedá.")).toBe("sk");
        expect(clearLanguage("Já si myslím, že je to prostě nějaký problém, protože se to nedá.")).toBe("cs");
        expect(clearLanguage("OK.")).toBeUndefined();
    });

    test("an unclear line takes its speaker's languages, the most common first", () => {
        const slovak = { speaker: "Bob Example", text: "Ja si myslím, že sa to nedá, lebo nie." };
        const czech = { speaker: "Bob Example", text: "Já si myslím, že se to nedá, protože ne." };

        expect(
            lineLanguages([
                slovak,
                slovak,
                slovak,
                czech,
                czech,
                czech,
                czech,
                { speaker: "Bob Example", text: "OK." },
                { speaker: "Carol Example", text: "OK." },
            ]).slice(-3)
        ).toEqual([["cs", "sk"], ["cs", "sk"], ["cs"]]);
    });
});
