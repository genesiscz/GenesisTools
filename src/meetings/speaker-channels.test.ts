import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { correlateEcho } from "@genesiscz/utils/meetings/echo";
import { silentCallSpans } from "@genesiscz/utils/meetings/energy";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { editMeetingPerson, microphoneCandidates } from "@genesiscz/utils/meetings/room-people";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { clusterVoices, lineVoices, measureVoice, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { type LineEvidence, lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { CallTimeline } from "./lib/call-timeline";
import { identifiedDepartures } from "./lib/departure";
import { MEETING_PLATFORMS } from "./lib/platforms";
import { teamsAttendanceFromJson } from "./lib/platforms/teams";
import { assessIndicator } from "./lib/speaker-indicator";
import { suggestItems } from "./lib/suggest";
import { lineDeviceCandidates } from "./lib/voice";
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
        expect(found.find((item) => item.fromSec === 600)).toMatchObject({
            speaker: USER,
            rules: ["E1", "R18"],
            confidence: 0.7,
        });
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

    test("a platform label's microphone lines offer the user, never remote label owners", () => {
        const carol = found.filter((item) => item.label === "Carol Example" && item.rules.includes("R18"));

        expect(carol.length).toBeGreaterThan(0);
        expect(carol.every((item) => item.speaker === USER && item.rules.includes("R18"))).toBe(true);
        expect(carol[0]).toMatchObject({ confidence: 0.7, candidates: [USER] });
    });

    test("the larger microphone voice stays the user's, at most 0.7", () => {
        const bob = found.filter((item) => item.label === "Bob Example");

        expect(bob.length).toBeGreaterThan(0);
        expect(bob.every((item) => item.speaker === USER && (item.confidence ?? 1) <= 0.7)).toBe(true);
    });
});

describe("the recorder swapped the user's label and another person's for a stretch (R20)", () => {
    const normal: Slot[] = Array.from({ length: 60 }, (_, index) =>
        index % 2 === 0 ? { label: USER, mic: 0.95 } : { label: "Bob Example", mic: 0.05 }
    );
    const swapped: Slot[] = Array.from({ length: 60 }, (_, index) =>
        index % 2 === 0 ? { label: USER, mic: 0.05 } : { label: "Bob Example", mic: 0.95 }
    );

    test("each agreeing line gets a swap, and no competing per-line rule speaks there", () => {
        const { meeting, evidence, share } = scene([...normal, ...swapped]);
        const found = ranges(suggestItems({ ...base, meeting, evidence, energyMicShare: share }));

        const swaps = found.filter((item) => item.rules.includes("R20"));
        expect(swaps).toHaveLength(60);
        expect(swaps.every((item) => item.fromSec === item.toSec && item.confidence === 0.9)).toBe(true);
        expect(swaps.filter((item) => item.speaker === USER)).toHaveLength(30);
        expect(swaps.filter((item) => item.speaker === "Bob Example")).toHaveLength(30);
        expect(found.filter((item) => item.fromSec >= 600 && !item.rules.includes("R20"))).toEqual([]);
    });

    test("labels that read swapped through the whole call, or for under 10 min, are left to the per-line rules", () => {
        const whole = scene(swapped);
        expect(
            ranges(suggestItems({ ...base, ...whole, energyMicShare: whole.share })).some((item) =>
                item.rules.includes("R20")
            )
        ).toBe(false);

        const short = scene([...normal, ...swapped.slice(0, 20), ...normal]);
        expect(
            ranges(suggestItems({ ...base, ...short, energyMicShare: short.share })).some((item) =>
                item.rules.includes("R20")
            )
        ).toBe(false);

        // 7:00 to 16:00 fills two swapped windows (5:00 to 10:00 and 10:00 to 15:00) but lasts 9 min.
        const offset = scene([...normal.slice(0, 42), ...swapped.slice(0, 54), ...normal]);
        expect(
            ranges(suggestItems({ ...base, ...offset, energyMicShare: offset.share })).some((item) =>
                item.rules.includes("R20")
            )
        ).toBe(false);
    });

    test("a greeting of someone who joins inside the stretch is not a second, competing item (R16)", () => {
        const { meeting, evidence, share } = scene([...normal, ...swapped]);
        const presence = [{ name: "Dan Example", fromSec: 890, toSec: 1200 }];
        const speaking = [{ tSec: 905, speaking: ["Dan Example"] }];
        const found = ranges(
            suggestItems({ ...base, meeting, evidence: { ...evidence, speaking }, energyMicShare: share, presence })
        );

        expect(found.filter((item) => item.rules.includes("R20"))).toHaveLength(60);
        expect(found.filter((item) => item.rules.includes("R16"))).toEqual([]);
        expect(found.filter((item) => item.fromSec >= 600 && !item.rules.includes("R20"))).toEqual([]);
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

describe("Workshop regression boundaries", () => {
    test("a platform label cannot name its remote owner on a microphone lean", () => {
        const sample = scene([{ label: "Bob Example", mic: 0.68 }]);
        const found = ranges(suggestItems({ ...base, ...sample, energyMicShare: sample.share }));
        expect(found).toHaveLength(1);
        expect(found[0]?.speaker).toBe(USER);
        expect(found[0]?.confidence).toBeLessThanOrEqual(0.7);
        expect(found[0]?.candidates?.[0]).toBe(USER);
        expect(found[0]?.candidates).not.toContain("Bob Example");
    });

    test("R1 never opens later microphone lines of the recording user", () => {
        const sample = scene(
            Array.from({ length: 12 }, (_, index) => ({ label: USER, mic: index === 2 ? 0.15 : 0.98 }))
        );
        sample.meeting.transcript[2]!.text = "Dík, já vám mizím.";
        sample.meeting.transcript[3]!.text = "Ahoj, měj se.";
        const found = ranges(
            suggestItems({ ...base, ...sample, rules: ["speakers", "evidence"], energyMicShare: sample.share })
        );
        expect(found.filter((item) => item.label === USER && item.rules.includes("R1"))).toEqual([]);
    });

    test("R20 leaves correctly labelled lines inside a swapped stretch untouched", () => {
        const slots = Array.from({ length: 180 }, (_, index) => {
            const wrong = index >= 60 && index < 140;
            const self = index % 2 === 0;
            const correctException = index === 92 || index === 93;
            return { label: self ? USER : "Bob Example", mic: (wrong && !correctException) !== self ? 0.95 : 0.05 };
        });
        const sample = scene(slots);
        const found = ranges(suggestItems({ ...base, ...sample, energyMicShare: sample.share }));
        const swaps = found.filter((item) => item.rules.includes("R20"));
        expect(swaps.length).toBeGreaterThan(0);
        for (const index of [92, 93]) {
            expect(
                swaps.some(
                    (item) =>
                        item.label === slots[index]!.label && index * 10 >= item.fromSec && index * 10 <= item.toSec
                )
            ).toBe(false);
        }
        expect(swaps.some((item) => item.fromSec === 900)).toBe(true);
    });
});

describe("shared indicator and departure APIs", () => {
    test("a late remote join starts a new assessment stretch; one rare hit still supplies a candidate", () => {
        const sample = scene(Array.from({ length: 100 }, () => ({ label: USER, mic: 0.02 })));
        const lines: LineEvidence[] = lineEvidence(
            sample.meeting.transcript,
            sample.evidence,
            undefined,
            sample.share
        ).map(
            (line): LineEvidence => ({
                ...line,
                speaking: line.index < 20 ? {} : line.index === 40 ? { "Carol Example": 1 } : { "Bob Example": 1 },
                present: line.index < 40 ? ["Bob Example"] : ["Bob Example", "Carol Example"],
            })
        );
        const assessment = assessIndicator({ lines, selfName: USER });
        expect(assessment.candidates.map((person) => person.name)).toContain("Carol Example");
        expect(assessment.ignored.has(20)).toBe(false);
        expect(assessment.ignored.has(70)).toBe(true);
        const gaps = lines.map((line) => ({
            ...line,
            speaking: line.index > 41 && line.index < 99 ? {} : line.speaking,
        }));
        expect(assessIndicator({ lines: gaps, selfName: USER }).ignored.size).toBe(0);
    });

    test("a remote goodbye under the user label identifies only independently known identity", () => {
        const sample = scene([{ label: USER, mic: 0.15 }]);
        const lines = lineEvidence(sample.meeting.transcript, sample.evidence, undefined, sample.share);
        const hints = [
            {
                kind: "leave-then-continues" as const,
                label: USER,
                strength: "normal" as const,
                leaves: [{ atSec: 0, continuesAtSec: 40, text: "Já vám mizím." }],
            },
        ];
        const presence = ["Bob Example", "Carol Example"].map((name) => ({
            name,
            fromSec: 0,
            toSec: 120,
            leftAtExact: false,
        }));
        expect(identifiedDepartures({ hints, lines, selfName: USER, presence })).toEqual([]);
        const shown = [{ ...lines[0]!, speaking: { "Carol Example": 1 } }];
        expect(identifiedDepartures({ hints, lines: shown, selfName: USER, presence })).toEqual([
            { name: "Carol Example", atSec: 0, reason: "indicator" },
        ]);
        expect(
            identifiedDepartures({ hints, lines: shown, selfName: USER, presence, ignoredIndicator: new Set([0]) })
        ).toEqual([]);
    });
});

test("meeting-wide indicator dominance counts all transcript lines, with a strict 80 percent boundary", () => {
    const sample = scene(Array.from({ length: 100 }, () => ({ label: USER, mic: 0.02 })));
    const lines = lineEvidence(sample.meeting.transcript, sample.evidence, undefined, sample.share);
    const readings = (count: number): LineEvidence[] =>
        lines.map((line): LineEvidence => ({ ...line, speaking: line.index < count ? { "Bob Example": 1 } : {} }));
    const assessment = assessIndicator({ lines: readings(87), selfName: USER });
    expect(assessment.dominant).toEqual({ name: "Bob Example", share: 0.87 });
    expect(assessment.reasons.get(0)).toBe("meeting-dominance");
    expect(assessment.ignored.size).toBe(100);
    expect(assessIndicator({ lines: readings(80), selfName: USER }).dominant).toBeUndefined();
});

test("explicit shared microphone seats survive schema parsing and offer every room person", () => {
    const sample = scene([{ label: "Bob Example", mic: 0.95 }]);
    const parsed = meetingRecordSchema.parse({
        ...record,
        seats: { room: [USER, "Room Example"], remote: [{ name: "Bob Example" }] },
    });
    const reopened = meetingRecordSchema.parse(SafeJSON.parse(SafeJSON.stringify(parsed)));
    const found = ranges(suggestItems({ ...base, record: reopened, ...sample, energyMicShare: sample.share }));
    expect(found[0]?.speaker).toBeUndefined();
    expect(found[0]?.candidates).toEqual([USER, "Room Example"]);
    expect(found[0]?.candidates).not.toContain("Bob Example");
});

test("an identified remote departure removes that person after a goodbye under the user's label", () => {
    const sample = scene(
        Array.from({ length: 12 }, (_, index) => ({
            label: index === 8 ? "Carol Example" : USER,
            mic: index === 2 || index === 8 ? 0.15 : 0.98,
        }))
    );
    sample.meeting.transcript[2]!.text = "Dík, já vám mizím.";
    sample.evidence.speaking = [{ tSec: 20, speaking: ["Carol Example"] }];
    const presence = [USER, "Bob Example", "Carol Example"].map((name) => ({
        name,
        self: name === USER,
        fromSec: 0,
        toSec: 120,
        leftAtExact: false,
    }));
    const found = ranges(
        suggestItems({ ...base, ...sample, rules: ["speakers", "evidence"], presence, energyMicShare: sample.share })
    );
    expect(found.some((item) => item.label === USER && item.fromSec > 20 && item.rules.includes("R1"))).toBe(false);
    expect(found.find((item) => item.fromSec === 20 && item.rules.includes("R1"))?.speaker).toBe("Carol Example");
    const later = found.find((item) => item.label === "Carol Example" && item.fromSec === 80);
    expect(later).toBeDefined();
    expect(later?.speaker).not.toBe("Carol Example");
    expect(later?.candidates).not.toContain("Carol Example");
});

test("a linear echo residual does not turn a mixed microphone line into a remote identity", () => {
    const sample = scene([{ label: "Bob Example", mic: 0.02 }]);
    const audio = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 12));
    const acoustic = correlateEcho({ mic: audio, call: audio, rate: 1000 });
    const share = Object.assign(sample.share, { acoustic: () => acoustic });
    const found = ranges(suggestItems({ ...base, ...sample, energyMicShare: share }));
    expect(found).toHaveLength(1);
    expect(found[0]?.speaker).toBeUndefined();
    expect(found[0]?.candidates?.[0]).toBe(USER);
    expect(found[0]?.rules).toContain("R18");
});

test("R20 does not override a line when tagged channel and calibrated energy disagree", () => {
    const slots = Array.from({ length: 180 }, (_, index) => ({
        label: index % 2 === 0 ? USER : "Bob Example",
        mic: (index >= 60 && index < 140) !== (index % 2 === 0) ? 0.95 : 0.05,
    }));
    slots[94]!.mic = 0.95;
    const sample = scene(slots);
    sample.evidence.segments[94]!.channel = "system";
    const found = ranges(suggestItems({ ...base, ...sample, energyMicShare: sample.share }));
    expect(found.some((item) => item.rules.includes("R20"))).toBe(true);
    expect(
        found.some(
            (item) => item.rules.includes("R20") && item.label === USER && item.fromSec <= 940 && item.toSec >= 940
        )
    ).toBe(false);
});

import { Storage } from "@genesiscz/utils/storage/storage";
import { planByChannel } from "./lib/by-channel";
import { DecisionJournal } from "./lib/decision-journal";
import { compactEvidence, rawMeeting } from "./lib/raw";
import { rejectFilterIds } from "./lib/reject-filter";

test("channel plans split on eligibility and leave shared room voices unresolved", () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({
        index,
        fromSec: index * 10,
        label: "Room",
        text: "A sufficiently long transcript sentence.",
        channel: { micShare: [0.1, 0.1, 0.5, 0.9, 0.9, null][index] },
    }));
    const input = {
        label: "Room",
        room: ["Alice", "Bob"],
        remote: [{ name: "Carol" }, { name: "Dan", label: "Own", fromSec: 10 }],
        askRoom: { minSec: 8, max: 1 },
    };
    const plan = planByChannel({ lines, input });
    expect(plan.ranges.map((r) => [r.from, r.to, r.speaker, r.confidence])).toEqual([
        [0, 0, "Carol", 0.8],
        [10, 10, "Carol", 0.7],
    ]);
    expect(plan.roomOnly).toHaveLength(1);
    expect(plan.questions).toHaveLength(1);
    expect(plan.mixed.map((l) => l.index)).toEqual([2]);
    expect(planByChannel({ lines, input: { ...input, room: ["Alice"] } }).ranges.at(-1)?.speaker).toBe("Alice");
    expect(planByChannel({ lines, input: { label: "Room", remote: ["Carol", "Dan"] } }).unresolved).toHaveLength(1);
    expect(() => planByChannel({ lines, input: { label: "Room", micMax: 0.9, micMin: 0.1 } })).toThrow();
});

test("seats and atomic replacement persist, undo restores both and filter only selects suggestions", async () => {
    const storage = new Storage(`seats-channel-${process.pid}`);
    const store = new MeetingStore(storage);
    const now = "2026-01-01T00:00:00Z";
    const journal = new DecisionJournal({ store, ledger: () => undefined });
    const record = await store.create(
        { title: "Seat fixture", start: now, createdBy: "new" },
        { command: "test", change: "fixture" }
    );
    const seating = await journal.apply({
        meeting: record.id,
        actor: { kind: "cli" },
        action: { kind: "set", seats: { room: ["Alice"], remote: [{ name: "Carol" }] } },
    });
    expect(new MeetingStore(storage).read(record.id)?.seats?.room).toEqual(["Alice"]);
    const finding = {
        kind: "speaker-range" as const,
        from: 0,
        to: 10,
        label: "Room",
        speaker: "Carol",
        confidence: 0.5,
        reason: "explicit channel evidence",
    };
    await journal.apply({
        meeting: record.id,
        actor: { kind: "agent", harness: "fixture", session: null },
        action: { kind: "add", findings: [finding] },
    });
    const replacement = await journal.apply({
        meeting: record.id,
        actor: { kind: "agent", harness: "fixture", session: null },
        action: {
            kind: "add",
            findings: [{ ...finding, confidence: 0.8 }],
            replace: { by: "agent", kinds: ["speaker-range"] },
        },
    });
    const read = new MeetingStore(storage).read(record.id)!;
    expect(read.items.map((i) => i.status)).toEqual(["rejected", "suggested"]);
    expect(rejectFilterIds(read.items, { kind: "speaker-range", where: "confidence>=0.7" })).toEqual([
        read.items[1]!.id,
    ]);
    expect(rejectFilterIds(read.items, { where: "confidence<0.6" })).toEqual([]);
    expect(() => rejectFilterIds(read.items, { where: "process.exit()" })).toThrow();
    await journal.revert({ meeting: record.id, token: replacement.entry!.token, actor: { kind: "cli" } });
    expect(new MeetingStore(storage).read(record.id)?.items.map((i) => i.status)).toEqual(["suggested"]);
    await journal.revert({ meeting: record.id, token: seating.entry!.token, actor: { kind: "cli" } });
    expect(new MeetingStore(storage).read(record.id)?.seats).toBeUndefined();
});

test("compact evidence has 509 bounded rows with mic percent and unknown", () => {
    const raw = rawMeeting({
        record,
        meeting: {
            sourceMeetingId: "fixture",
            title: "Fixture",
            participants: [],
            folders: [],
            start: START,
            speakers: [],
            transcript: Array.from({ length: 509 }, (_, i) => ({
                speaker: "Room",
                text: "x".repeat(800),
                startSec: i * 2,
            })),
        },
        evidence: null,
        points: [],
    });
    raw.lines[0]!.channel.micShare = 0.2;
    const compact = compactEvidence(raw);
    expect(Buffer.byteLength(compact)).toBeLessThan(50_000);
    expect(compact.split("\n")).toHaveLength(510);
    expect(compact).toContain("mic20%");
    expect(compact).toContain("mic?");
});

import { attributeByChannel } from "./lib/channel-operation";
import { OpenedMeeting } from "./lib/opened-meeting";

test("the actual byChannel dry-run door writes nothing, apply persists the same planned ranges", async () => {
    const store = new MeetingStore(new Storage(`by-channel-door-${process.pid}`));
    const record = await store.create(
        {
            title: "Door fixture",
            start: START,
            createdBy: "new",
            seats: { room: ["Alice"], remote: [{ name: "Carol" }] },
        },
        { command: "test", change: "fixture" }
    );
    const fixture = scene([
        { label: "Room", mic: 0 },
        { label: "Room", mic: 0 },
        { label: "Room", mic: 1 },
    ]);
    const load = spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue(fixture.meeting);
    const evidence = spyOn(OpenedMeeting.prototype, "evidence").mockResolvedValue(fixture.evidence);
    const file = join(store.folder(record.id), "meeting.json");
    const before = {
        bytes: readFileSync(file, "utf8"),
        mtime: statSync(file).mtimeMs,
        files: readdirSync(store.folder(record.id)),
    };
    try {
        const input = { label: "Room", minChars: 0, dryRun: true };
        const dry = await attributeByChannel({ store, record, input });
        expect(dry.ranges.map((r) => r.speaker)).toEqual(["Carol", "Alice"]);
        expect(readFileSync(file, "utf8")).toBe(before.bytes);
        expect(statSync(file).mtimeMs).toBe(before.mtime);
        expect(readdirSync(store.folder(record.id))).toEqual(before.files);
        await attributeByChannel({ store, record, input: { ...input, dryRun: false } });
        expect(
            new MeetingStore(store.storage)
                .read(record.id)
                ?.items.filter((i) => i.kind === "speaker-range")
                .map((i) => (i.kind === "speaker-range" ? i.speaker : ""))
        ).toEqual(["Carol", "Alice"]);
    } finally {
        load.mockRestore();
        evidence.mockRestore();
    }
});

test("one shared indicator assessment marks strict meeting dominance and raw evidence exposes no signal", () => {
    const lines: LineEvidence[] = Array.from(
        { length: 100 },
        (_, index): LineEvidence => ({
            index,
            startSec: index * 10,
            endSec: index * 10 + 9,
            label: "Room",
            text: "Words",
            speaking: index < 87 ? { Carol: 1 } : {},
        })
    );
    const assessed = assessIndicator({ lines, selfName: "Alice" });
    expect(assessed.dominant).toEqual({ name: "Carol", share: 0.87 });
    expect(assessed.ignored.size).toBe(100);
    expect(assessed.reasons.get(0)).toBe("meeting-dominance");
    expect(
        assessIndicator({
            lines: lines.map((line, index): LineEvidence => ({ ...line, speaking: index < 80 ? { Carol: 1 } : {} })),
            selfName: "Alice",
        }).dominant
    ).toBeUndefined();
    const fixture = scene(Array.from({ length: 100 }, () => ({ label: "Room", mic: 0 })));
    fixture.evidence.speaking = Array.from({ length: 100 }, (_, index) => ({
        tSec: index * 10,
        speaking: index < 87 ? ["Carol"] : [],
    }));
    const raw = rawMeeting({ record, meeting: fixture.meeting, evidence: fixture.evidence, points: [] });
    expect(raw.meeting.indicator?.signal).toBe("no-signal");
    expect(raw.lines[0]?.speakingSignal).toBe("no-signal");
});

test("raw evidence carries canonical seats and explicit project roles through aliases", () => {
    const fixture = scene([{ label: "Room", mic: 0 }]);
    const seated = { ...record, seats: { room: ["Al"], remote: [{ name: "Carol" }] } };
    const raw = rawMeeting({
        record: seated,
        meeting: fixture.meeting,
        evidence: fixture.evidence,
        points: [],
        people: [{ name: "Alice", role: "Engineer", aliases: ["Al"], pairedBy: [{ kind: "manual", at: START }] }],
    });
    expect(raw.meeting.seats).toEqual(seated.seats);
    expect(raw.people.find((person) => person.name === "Al")).toMatchObject({ role: "Engineer", aliases: ["Al"] });
    expect(raw.people.find((person) => person.name === "Carol")?.role).toBeUndefined();
});

test("shared microphone never identifies its owner as fact", () => {
    const shared = meetingRecordSchema.parse({
        ...record,
        seats: {
            room: [USER, "Dana Example", "Eli Example"],
            remote: [],
            microphones: [{ id: "self", people: [USER, "Dana Example", "Eli Example"] }],
        },
    });
    for (const micShare of [0.65, 0.8, 0.9, 1]) {
        expect(lineDeviceCandidates({ record: shared, atSec: 10, micShare })).toEqual([
            USER,
            "Dana Example",
            "Eli Example",
        ]);
    }
    expect(lineDeviceCandidates({ record: shared, atSec: 10, micShare: 0.64 })).toEqual([]);
    const s = scene([
        { label: USER, mic: 1 },
        { label: USER, mic: 1 },
    ]);
    const items = ranges(
        suggestItems({ ...base, record: shared, meeting: s.meeting, evidence: s.evidence, energyMicShare: s.share })
    );
    expect(items.length).toBeGreaterThan(0);
    expect(
        items.every(
            (item) =>
                !item.speaker && item.candidates?.includes("Dana Example") && item.candidates?.includes("Eli Example")
        )
    ).toBe(true);
});

test("manual room and remote device stays persist through a reopened store, updates and removal", async () => {
    const storage = new Storage(`room-people-${process.pid}`);
    const store = new MeetingStore(storage);
    mkdirSync(store.folder(record.id), { recursive: true });
    writeFileSync(
        join(store.folder(record.id), "meeting.json"),
        SafeJSON.stringify({ ...record, end: "2026-11-03T13:00:00Z" })
    );
    await editMeetingPerson({
        store,
        meeting: record.id,
        edit: { action: "add", name: "Dana Example", atMic: true, fromSec: 10, toSec: 100 },
    });
    let saved = new MeetingStore(storage).resolve(record.id)!;
    expect(saved.participants.map((p) => p.name)).toContain("Dana Example");
    expect(microphoneCandidates(saved, 10)).toEqual([USER, "Dana Example"]);
    expect(microphoneCandidates(saved, 100)).toEqual([USER]);
    await editMeetingPerson({
        store,
        meeting: record.id,
        edit: { action: "add", name: "Eli Example", via: "Robin Example", fromSec: 20, toSec: 80 },
    });
    saved = new MeetingStore(storage).resolve(record.id)!;
    expect(microphoneCandidates(saved, 30, "Robin Example")).toEqual(["Robin Example", "Eli Example"]);
    await editMeetingPerson({
        store,
        meeting: record.id,
        edit: { action: "add", name: "Dana Example", fromSec: 15, toSec: 110 },
    });
    expect(microphoneCandidates(new MeetingStore(storage).resolve(record.id)!, 16)).toContain("Dana Example");
    await editMeetingPerson({ store, meeting: record.id, edit: { action: "remove", name: "Dana Example" } });
    saved = new MeetingStore(storage).resolve(record.id)!;
    expect(saved.attendance!.people.every((p) => p.name !== "Dana Example")).toBe(true);
    expect(saved.seats!.room).not.toContain("Dana Example");
    expect(saved.sections!.flatMap((s) => s.present)).not.toContain("Dana Example");
});

test("streamed synthetic stereo voice features preserve pitch, level, silence and anchored clusters", async () => {
    const folder = new Storage(`room-voice-audio-${process.pid}`).getBaseDir();
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "stereo.wav");
    const rate = 8000,
        samples = rate * 2;
    const wav = Buffer.alloc(44 + samples * 4);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 4, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 4, 40);
    for (let i = 0; i < samples; i++) {
        wav.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * (i < rate ? 125 : 250) * i) / rate)), 44 + i * 4);
        wav.writeInt16LE(i < rate ? Math.round(4000 * Math.sin((2 * Math.PI * 200 * i) / rate)) : 0, 46 + i * 4);
    }
    writeFileSync(file, wav);
    const frames = await voiceFrames({ audioPath: file });
    expect(frames.length).toBe(40);
    const lines = lineVoices({
        frames,
        spans: [
            { index: 0, fromSec: 0, toSec: 1 },
            { index: 1, fromSec: 1, toSec: 2 },
        ],
    });
    expect(lines[0]!.channels[0]!.pitchHz!).toBeCloseTo(125, 0);
    expect(lines[1]!.channels[0]!.pitchHz!).toBeCloseTo(250, 0);
    expect(lines[0]!.channels[0]!.rms / lines[0]!.channels[1]!.rms).toBeCloseTo(4, 1);
    expect(lines[1]!.channels[1]!.pitchHz).toBeNull();
    expect(lines[1]!.channels[0]!.lowBandShare).toBeLessThan(lines[0]!.channels[0]!.lowBandShare);
    expect(lines[1]!.channels[0]!.tilt).toBeGreaterThan(lines[0]!.channels[0]!.tilt);
    const clustered = clusterVoices({
        lines,
        voices: 2,
        channel: 0,
        anchors: new Map([
            [0, "Dana"],
            [1, "Robin"],
        ]),
    });
    expect(clustered.map((line) => line.cluster?.speaker)).toEqual(["Dana", "Robin"]);
    expect(clustered.every((line) => line.cluster!.confidence > 0.9)).toBe(true);
    expect(measureVoice(new Float32Array(400)).pitchHz).toBeNull();
    expect(() => clusterVoices({ lines, voices: 0, channel: 0 })).toThrow();
});

test("attendance chat id is forwarded byte-for-byte through CallTimeline", async () => {
    const selected = spyOn(MEETING_PLATFORMS.teams, "attendance").mockResolvedValue({ presence: [], note: "fixture" });
    try {
        await CallTimeline.stored(record).stays("teams", { id: "19:opaque+chat@thread.v2" });
        expect(selected).toHaveBeenCalledWith(expect.objectContaining({ title: "Room", start: START }), {
            id: "19:opaque+chat@thread.v2",
        });
    } finally {
        selected.mockRestore();
    }
});

test("pitch identity is stable across gain changes and unnamed clusters remain unnamed", () => {
    const sample = (index: number, pitchHz: number, rms: number) => ({
        index,
        channels: [{ rms, pitchHz, lowBandShare: 0.5, tilt: 0.1, voicedShare: 1 }],
    });
    const result = clusterVoices({
        lines: [sample(0, 125, 0.1), sample(1, 250, 0.2), sample(2, 250, 0.5)],
        channel: 0,
        voices: 2,
        anchors: new Map([
            [0, "Dana"],
            [1, "Robin"],
        ]),
    });
    expect(result[2]!.cluster!.speaker).toBe("Robin");
    const anonymous = clusterVoices({ lines: [sample(0, 125, 0.1), sample(1, 250, 0.2)], channel: 0, voices: 2 });
    expect(
        clusterVoices({
            lines: [
                {
                    index: 0,
                    channels: [{ rms: 0, pitchHz: null, lowBandShare: 0, tilt: 0, voicedShare: 0 }],
                    cluster: { id: 0, confidence: 1, speaker: "stale" },
                },
            ],
            channel: 0,
            voices: 1,
        })[0]!.cluster
    ).toBeUndefined();
    expect(anonymous.every((line) => line.cluster?.speaker === undefined)).toBe(true);
});
