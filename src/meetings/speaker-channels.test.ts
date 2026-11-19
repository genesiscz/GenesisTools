import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import type { AcousticShare } from "@genesiscz/utils/meetings/echo";
import { correlateEcho } from "@genesiscz/utils/meetings/echo";
import { silentCallSpans } from "@genesiscz/utils/meetings/energy";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { editMeetingPerson, microphoneCandidates } from "@genesiscz/utils/meetings/room-people";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import {
    activeSeatPeople,
    meetingSeatsSchema,
    seatIntervalsFor,
    seatsFingerprint,
} from "@genesiscz/utils/meetings/seats";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { embedVoice, VoiceUnavailableError } from "@genesiscz/utils/meetings/voice";
import { clusterVoices, lineVoices, measureVoice, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { Storage } from "@genesiscz/utils/storage/storage";
import { type LineEvidence, lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { decimate } from "./lib/acoustic";
import { planByChannel } from "./lib/by-channel";
import { callMutes, MutedCallLines } from "./lib/call-mutes";
import { CallTimeline } from "./lib/call-timeline";
import { attributeByChannel } from "./lib/channel-operation";
import { DecisionJournal } from "./lib/decision-journal";
import { identifiedDepartures } from "./lib/departure";
import { OpenedMeeting } from "./lib/opened-meeting";
import { storedPresentAt } from "./lib/person-stays";
import { MEETING_PLATFORMS } from "./lib/platforms";
import { teamsAttendanceFromJson } from "./lib/platforms/teams";
import { answerQuestion } from "./lib/questions";
import { compactEvidence, rawMeeting } from "./lib/raw";
import { rejectFilterIds } from "./lib/reject-filter";
import { decidedSeatRanges, suggestSeats } from "./lib/seat-suggest";
import { assessIndicator } from "./lib/speaker-indicator";
import { proposeSpeakerLabels } from "./lib/speaker-labels";
import { suggestItems } from "./lib/suggest";
import { correctTranscript } from "./lib/transcript-corrections";
import { anchoredMeetingVoices, lineDeviceCandidates } from "./lib/voice";
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

describe("seat suggestions", () => {
    test("timed seats keep the gap between two remote stays in a suggestion", () => {
        const name = "Fern Example";
        const stays = [
            { fromSec: 0, toSec: 5 },
            { fromSec: 10, toSec: 15 },
        ];
        const seated = meetingRecordSchema.parse({
            ...record,
            participants: [
                { name, from: ["platform-roster"], stays: stays.map((s) => ({ ...s, source: "platform-roster" })) },
            ],
        });
        const { seats } = suggestSeats({ record: seated, ranges: [], lines: [], remote: [name] });
        expect(seats.remote).toEqual(stays.map((s) => ({ name, ...s })));
        expect(activeSeatPeople({ seats, atSec: 5 }).remote).toEqual([]);
    });

    test("timed seats follow the person across devices independently of their Teams leave", async () => {
        const name = "Fern Example";
        const seats = meetingSeatsSchema.parse({
            room: [{ name, fromSec: 60, toSec: 120 }],
            remote: [{ name, toSec: 60 }],
            microphones: [
                { id: "self", people: [name] },
                { id: "guest-desk", deviceId: "desk", people: [name] },
            ],
        });
        const presence = [{ name, fromSec: 0, toSec: 80 }];
        const seated = meetingRecordSchema.parse({ ...record, seats, attendance: { from: "teams", people: presence } });
        expect(seatIntervalsFor(seats, "Example, Fern")).toEqual([
            { side: "call", fromSec: 0, toSec: 60 },
            { side: "mic", fromSec: 60, toSec: 120 },
        ]);
        expect(storedPresentAt(seated, name, 60)).toBe(true);
        expect(storedPresentAt(seated, name, 90)).toBe(false);
        expect(microphoneCandidates(seated, 59)).toEqual([]);
        expect(microphoneCandidates(seated, 59, "desk")).toEqual([name]);
        for (const atSec of [60, 90]) {
            expect(activeSeatPeople({ seats, atSec })).toEqual({ room: [name], remote: [] });
            expect(microphoneCandidates(seated, atSec)).toEqual([name]);
            expect(microphoneCandidates(seated, atSec, "desk")).toEqual([]);
        }
        expect(microphoneCandidates(seated, 120)).toEqual([]);
        expect(microphoneCandidates(seated, 30, name)).toEqual([]);
        const lines = [{ index: 0, label: "Guest", text: "A line across seats.", fromSec: 59, toSec: 61 }];
        for (const micShare of [0, 1]) {
            expect(
                planByChannel({
                    seats,
                    lines: lines.map((l) => ({ ...l, channel: { micShare } })),
                    input: { label: "Guest", minChars: 0 },
                }).ranges
            ).toEqual([]);
        }
        // A second room occupant has a different mapped input. Only the moving guest occupies this Mac's mic.
        const opened = OpenedMeeting.of(new MeetingStore(), {
            ...seated,
            seats: {
                ...seats,
                room: [...seats.room, "Vale Example"],
                microphones: [...(seats.microphones ?? []), { id: "table", people: ["Vale Example"] }],
            },
        });
        const meeting = scene([]).meeting;
        meeting.transcript = [59, 61, 90, 100].map((startSec) => ({ startSec, speaker: "Guest", text: "A line." }));
        spyOn(opened, "meeting").mockResolvedValue(meeting);
        spyOn(opened, "energy").mockResolvedValue({});
        spyOn(opened, "evidence").mockResolvedValue({
            speaking: [],
            files: [],
            segments: [{ startSec: 59, endSec: 100, channel: "mic" }],
        });
        const settings = meetingsConfigSchema.parse({}).global.speakerLabels;
        settings.seat.enabled = true;
        settings.voice.enabled = false;
        const labels = await proposeSpeakerLabels(opened, settings, presence);
        expect(labels.slice(0, 3).map((label) => label.person)).toEqual([undefined, name, name]);
    });

    test("self wins, decided microphone lines override a muted roster, and a range alone can seat a person", () => {
        const row = (name: string) => ({ name, from: ["platform-roster"] });
        const meeting = meetingRecordSchema.parse({
            ...record,
            participants: [
                ...record.participants,
                row("Indigo"),
                row("Fern"),
                row("Lake"),
                row("Pine"),
                { ...row("Reed"), stays: [{ fromSec: 5.5, toSec: 17.25, source: "platform-roster" }] },
            ],
            evidence: {
                indicator: [
                    { tSec: 6, speaking: [], muted: ["Indigo", "Lake"] },
                    { tSec: 7, speaking: [], muted: ["Indigo", "Lake", "Pine"] },
                ],
            },
        });
        const channels = [
            [USER, 0.1],
            ["Indigo", 0.8],
            ["Amber", 0.9],
            ["Reed", 0.1],
        ] as const;
        const result = suggestSeats({
            record: meeting,
            ranges: channels.map(([person]) => ({ label: person, person, fromSec: 6, toSec: 10 })),
            lines: channels.flatMap(([label, energyMicRaw]) =>
                Array.from({ length: 5 }, (_, i) => ({ startSec: 6 + i, label, energyMicRaw }))
            ),
        });
        expect(result.seats).toEqual({
            room: [USER, "Indigo", "Amber"],
            remote: [{ name: "Reed", fromSec: 5.5, toSec: 17.25 }],
        });
        expect(result.people.find((p) => p.name === "Lake")).toMatchObject({
            seat: "unsure",
            reason: "Muted on all 2 roster reads while present.",
        });
        expect(result.people.find((p) => p.name === "Reed")?.reason).toBe("5 of 5 decided lines on the call.");
    });

    test("only explicit mute lists in a stay count, even when two quiet accounts have different physical seats", () => {
        const people = ["Quill Example", "Lark Example"];
        const meeting = meetingRecordSchema.parse({
            ...record,
            participants: people.map((name) => ({ name, from: ["platform-roster"], firstSeenSec: 10 })),
            evidence: {
                indicator: [
                    { tSec: 9, muted: [], speaking: people },
                    ...Array.from({ length: 10 }, (_, i) => ({
                        tSec: 10 + i,
                        muted: i < 9 ? people : [],
                        speaking: [],
                    })),
                    ...Array.from({ length: 100 }, (_, i) => ({ tSec: 20 + i, speaking: [] })),
                    { tSec: 120, reason: "partial_tree", muted: [], speaking: people },
                ],
            },
        });
        const input = { record: meeting, ranges: [], lines: [] };
        const preview = suggestSeats(input);
        expect(preview.seats).toEqual({ room: [], remote: [] });
        expect(preview.people).toEqual(
            people.map((name) => ({
                name,
                seat: "unsure",
                confidence: 0,
                reason: "Muted on 9 of 10 explicit mute reads while present.",
            }))
        );
        expect(suggestSeats({ ...input, room: [people[0]!], remote: [people[1]!] }).seats).toEqual({
            room: [people[0]!],
            remote: [{ name: people[1]!, fromSec: 10 }],
        });

        const reads = meeting.evidence!.indicator!;
        reads.push({ tSec: 121, speaking: people, speakingUnknown: true });
        expect(suggestSeats(input).people).toEqual(preview.people);
        reads.push({ tSec: 122, speaking: people });
        const spoke = suggestSeats(input);
        expect(spoke.people.map((p) => p.reason)).toEqual(
            people.map(
                () =>
                    "Physical seat unknown. 9 of 10 explicit mute lists included this account. Observed speaking on the call."
            )
        );
        expect(spoke.seats).toEqual(preview.seats);
    });

    test("the 80 percent hint needs explicit coverage and a quiet roster does not establish a physical seat", () => {
        const name = "Finch Example";
        const reason = (positive: number, total: number) => {
            const meeting = meetingRecordSchema.parse({
                ...record,
                participants: [{ name, from: ["platform-roster"] }],
                evidence: {
                    indicator: Array.from({ length: total }, (_, i) => ({
                        tSec: i,
                        speaking: [],
                        speakingUnknown: true,
                        muted: i < positive ? [name] : [],
                    })),
                },
            });
            const result = suggestSeats({ record: meeting, ranges: [], lines: [] });
            expect(result.people[0]?.seat).toBe("unsure");
            expect(result.seats.remote).toEqual([]);
            return result.people[0]?.reason;
        };
        expect(reason(4, 5)).toBe("Muted on 4 of 5 explicit mute reads while present.");
        expect(reason(3, 5)).toBe("Physical seat unknown. 3 of 5 explicit mute lists included this account.");
        expect(reason(0, 0)).toContain("No explicit mute reads");
    });

    test("a seat preview keeps saved intervals and device memberships before considering roster or decided-line hints", () => {
        const name = "Quill Example";
        const seats = meetingSeatsSchema.parse({
            room: [{ name, fromSec: 20, toSec: 40 }],
            remote: [
                { name, label: "Desk", toSec: 20 },
                { name, label: "Desk", fromSec: 50 },
            ],
            microphones: [
                { id: "self", people: [name] },
                { id: "desk", people: [name] },
            ],
        });
        const meeting = meetingRecordSchema.parse({
            ...record,
            seats: { ...seats, remote: [...seats.remote, { name: "Empty desk", fromSec: 10, toSec: 10 }] },
            participants: [{ name, from: ["platform-roster"] }],
        });
        const result = suggestSeats({
            record: meeting,
            ranges: [{ label: "S1", person: name, fromSec: 0, toSec: 10 }],
            lines: Array.from({ length: 5 }, (_, startSec) => ({ label: "S1", startSec, energyMicRaw: 1 })),
        });
        expect(result.seats).toEqual(seats);
        expect(result.people[0]?.reason).toBe("Saved room and remote intervals.");
    });

    test("only reads during each recorded stay count, including the join and excluding the leave", () => {
        const meeting = meetingRecordSchema.parse({
            ...record,
            participants: [],
            attendance: {
                from: "fixture",
                people: [
                    { name: "Wren", fromSec: 10, toSec: 20 },
                    { name: "Wren", fromSec: 30, toSec: 40 },
                ],
            },
            evidence: {
                indicator: [9, 10, 20, 25, 30, 40].map((tSec) => ({
                    tSec,
                    speaking: [],
                    muted: [10, 30].includes(tSec) ? ["Wren"] : [],
                })),
            },
        });
        const input = { record: meeting, ranges: [], lines: [] };
        expect(suggestSeats(input).people[0]).toMatchObject({
            seat: "unsure",
            reason: "Muted on all 2 roster reads while present.",
        });
        expect(suggestSeats({ ...input, remote: ["wren"] }).seats.remote).toEqual([
            { name: "Wren", fromSec: 10, toSec: 20 },
            { name: "Wren", fromSec: 30, toSec: 40 },
        ]);
    });

    test("the remote device's attendance covers its occupants after a personal account disconnects", () => {
        const person = "Pip Example";
        const device = "Shared desk";
        const meeting = meetingRecordSchema.parse({
            ...record,
            seats: {
                room: [],
                remote: [{ name: person }],
                microphones: [{ id: "desk", deviceId: device, people: [person] }],
            },
            attendance: {
                from: "fixture",
                people: [
                    { name: person, fromSec: 0, toSec: 10 },
                    { name: device, fromSec: 5, toSec: 30 },
                ],
            },
        });
        expect(microphoneCandidates(meeting, 4, "desk")).toEqual([]);
        expect(microphoneCandidates(meeting, 20, "desk")).toEqual([person]);
        expect(microphoneCandidates(meeting, 30, "desk")).toEqual([]);
    });

    test.each([
        ["room", [0.66, 0.66, 0.66, 0.65, undefined]],
        ["remote", [0.34, 0.34, 0.34, 0.35, undefined]],
        ["unsure", [0.99, 0.99, 0.99, 0.99]],
        ["unsure", [0.99, 0.99, 0.65, 0.35, 0.35]],
        ["unsure", [0.34, 0.34, undefined, undefined, undefined]],
    ] as const)("decided lines yield %s for shares %j", (seat, shares) => {
        const input = {
            record,
            ranges: [{ label: "S1", fromSec: 0, toSec: 7, person: "Moss" }],
            lines: shares.map((energyMicRaw, startSec) => ({ label: "S1", startSec, energyMicRaw })),
        };
        expect(suggestSeats(input).people.find((person) => person.name === "Moss")?.seat).toBe(seat);
    });

    test("a line votes once for its latest assignment; a proposal, rejection, machine decision or split casts no vote", () => {
        const range = {
            label: "S1",
            kind: "speaker-range",
            fromSec: 0,
            toSec: 4,
            status: "confirmed",
            suggestedAt: START,
        };
        const meeting = meetingRecordSchema.parse({
            ...record,
            participants: [],
            items: [
                { ...range, id: "i1", speaker: "Fern" },
                { ...range, id: "i2", label: "S2", speaker: "Pine", status: "suggested" },
                { ...range, id: "i3", label: "S3", speaker: "Ash", status: "rejected" },
                { ...range, id: "i4", label: "S4", speaker: "Elm", voices: ["Elm", "Ivy"] },
                {
                    ...range,
                    id: "i5",
                    label: "S5",
                    speaker: "Reed",
                    decision: {
                        token: "t",
                        previous: { status: "suggested" },
                        actor: { kind: "rule", rule: "fixture" },
                    },
                },
            ],
            speakers: { assignments: [{ id: "a1", label: "S1", person: "Lake", fromSec: 0, toSec: 4, at: START }] },
        });
        const lines = ["S1", "S2", "S3", "S4", "S5"].flatMap((label) =>
            Array.from({ length: 5 }, (_, startSec) => ({ label, startSec, energyMicRaw: 1 }))
        );
        expect(suggestSeats({ record: meeting, ranges: decidedSeatRanges(meeting), lines }).people).toEqual([
            { name: "Lake", seat: "room", reason: "5 of 5 decided lines on the microphone.", confidence: 1 },
        ]);
    });
});

describe("sparse roster mute readings on the call", () => {
    const reed = "Reed Example";
    const lake = "Lake Example";
    const dale = "Dale Example";
    test("opposed channels cannot veto a person in a line or a sampled range", () => {
        const line: LineEvidence = {
            index: 0,
            startSec: 3,
            endSec: 5,
            label: "S1",
            text: "Yes",
            speaking: {},
            muted: [reed],
            energyMic: 0.2,
            micShare: 0.7,
        };
        expect(callMutes(line)).toEqual([]);
        expect(new MutedCallLines([line]).forIndices([0])).toEqual([]);
        expect(callMutes({ ...line, micShare: 0.49 })).toEqual([reed]);
    });
    const transcriptAt = (startSec: number) => [
        {
            speaker: lake,
            startSec,
            text: "We agreed to send the full list of changes before the team meets again on Friday morning.",
        },
    ];

    function at(options: {
        sec: number;
        unmute?: boolean;
        third?: boolean;
        mutedCarrySec?: number;
        applyAbove?: number;
    }) {
        const { meeting, evidence } = scene([{ label: lake, mic: 0 }]);
        meeting.transcript = transcriptAt(options.sec);
        if (options.applyAbove !== undefined) {
            meeting.transcript[0]!.text = "Yes please.";
        }
        meeting.speakers = [{ speakerId: 1, name: lake, origin: "platform" }];
        evidence.segments = [{ startSec: 0, endSec: 1000, channel: "system" }];
        evidence.speaking = [
            { tSec: 0, speaking: [], muted: [reed], validUntilSec: 5 },
            { tSec: 5, speaking: [], speakingUnknown: true },
            ...(options.unmute ? [{ tSec: 150, speaking: [], muted: [] }] : []),
            { tSec: 200, speaking: [], muted: [reed] },
        ];
        const people = options.third ? [lake, reed, dale] : [lake, reed];
        const presence = people.map((name) => ({ name, fromSec: 0, toSec: 1000 }));
        return suggestItems({
            ...base,
            meeting,
            evidence: { ...evidence, mutedCarrySec: options.mutedCarrySec },
            applyAbove: options.applyAbove,
            questionBudget: options.applyAbove === undefined ? undefined : 0,
            labels:
                options.applyAbove === undefined
                    ? undefined
                    : [{ labeler: "seat", reason: "seat-of-one", person: lake, seat: "call", index: 0 }],
            presence,
        });
    }

    for (const applyAbove of [0, 0.4, 0.7]) {
        test(`R3 sole remote needs an individual review at apply ${applyAbove}`, async () => {
            const items = at({ sec: 100, applyAbove });
            const [range] = ranges(items);
            expect(range?.rules).toContain("RM");
            expect(range?.evidence?.reviewOnly).toBe(true);
            expect(range?.confidence).toBeLessThanOrEqual(Math.max(0, applyAbove - 0.01) + Number.EPSILON);
            expect(range?.speaker).toBe(applyAbove === 0 ? undefined : lake);
            expect(items.find((item) => item.kind === "question")).toMatchObject({
                choices: [lake],
                decides: [range!.id],
            });
            const result = correctTranscript({
                record: meetingRecordSchema.parse({ ...record, items }),
                transcript: transcriptAt(100),
                config: meetingsConfigSchema.parse({}),
                format: "json",
                withSuggested: true,
                applyAbove: 0,
                dictionary: false,
            });
            expect(result.entries[0]?.band).not.toBe("applied");
            const store = new MeetingStore(new Storage(`r3-sole-remote-${applyAbove}`));
            const saved = await store.create({ ...record, items }, { command: "fixture", change: "review" });
            const bulk = await new DecisionJournal({ store }).plan({
                meeting: saved.id,
                actor: { kind: "cli" },
                action: { kind: "confirm", items: [], minConfidence: 0 },
            });
            expect(bulk.skipped).toContainEqual(expect.objectContaining({ id: range!.id, needs: "listen" }));
        });
    }

    test("R3 positive mic voices survive a personal mute and an absent call account", () => {
        const { meeting, evidence } = scene([
            { label: "S1", mic: 1 },
            { label: "S2", mic: 1 },
        ]);
        const seated = meetingRecordSchema.parse({ ...record, seats: { room: [USER, reed], remote: [] } });
        const measuredLines = lineEvidence(meeting.transcript, evidence).map((line, index) => ({
            ...line,
            muted: [reed],
            present: [USER],
            voice: {
                person: index === 0 ? reed : USER,
                quality: "matched" as const,
                model: "fixture",
                reason: "independent match",
                candidates: [],
            },
        }));
        const items = suggestItems({ ...base, meeting, evidence, record: seated, measuredLines });
        expect(ranges(items).map((item) => [item.speaker, item.rules.includes(MeetingRule.Voice)])).toEqual([
            [reed, true],
            [USER, true],
        ]);
    });

    test("R3 an unmute splits group answers at the eligibility boundary", () => {
        const { meeting, evidence } = scene([
            { label: "S1", mic: 0 },
            { label: "S1", mic: 0 },
        ]);
        const seated = meetingRecordSchema.parse({
            ...record,
            seats: { room: [USER], remote: [{ name: reed }, { name: lake }] },
        });
        const measuredLines = lineEvidence(meeting.transcript, evidence).map((line) => ({
            ...line,
            muted: line.index === 0 ? [reed] : [],
        }));
        const fresh = suggestItems({
            ...base,
            record: seated,
            meeting,
            evidence,
            measuredLines,
            rules: ["speakers"],
            labels: measuredLines.map((line) => ({
                index: line.index,
                seat: "call",
                labeler: "voice",
                reason: "not-the-seat-person",
                next: { person: lake, score: 0.1 },
            })),
        });
        const asked = fresh.filter((item) => item.kind === "question");
        expect(asked.map((item) => item.fromSec)).toEqual([0, 10]);
        expect(asked[0]?.choices).not.toContain(reed);
        expect(asked[1]?.choices).toContain(reed);
        expect(asked[1]?.decides).toHaveLength(1);
        const review = meetingRecordSchema.parse({ ...seated, items: fresh });
        answerQuestion(review, asked[1]!.id, { answer: reed, now: START });
        expect(review.items.find((item) => item.id === asked[0]!.decides[0])?.status).toBe("suggested");
        expect(review.items.find((item) => item.id === asked[1]!.decides[0])).toMatchObject({
            status: "confirmed",
            speaker: reed,
        });
    });

    test("two eligible remotes stay a question and the roster cannot add the muted third choice back", () => {
        const items = at({ sec: 100, third: true });
        expect(ranges(items)).toMatchObject([{ candidates: [lake, dale], confidence: 0.4 }]);
        const question = items.find((item) => item.kind === "question");
        expect(question?.choices).toContain(lake);
        expect(question?.choices).toContain(dale);
        expect(question?.choices).not.toContain(reed);
    });

    test("an explicit unmute at 150 restores the choice until the next mute at 200", () => {
        expect(ranges(at({ sec: 130, unmute: true }))).toMatchObject([{ speaker: lake }]);
        expect(ranges(at({ sec: 170, unmute: true }))).toMatchObject([{ candidates: [lake, reed] }]);
        expect(ranges(at({ sec: 240, unmute: true }))).toMatchObject([{ speaker: lake }]);
    });

    test("a configurable cap expires even when the next roster read agrees", () => {
        expect(ranges(at({ sec: 100, mutedCarrySec: 110 }))).toMatchObject([{ speaker: lake }]);
        expect(ranges(at({ sec: 100, mutedCarrySec: 103 }))).toMatchObject([{ candidates: [lake, reed] }]);
        expect(ranges(at({ sec: 100, mutedCarrySec: 90 }))).toMatchObject([{ candidates: [lake, reed] }]);
        expect(ranges(at({ sec: 801 }))).toMatchObject([{ candidates: [lake, reed] }]);
    });

    test("opened meetings apply the saved carry limit to the same readings used by suggestions and raw evidence", async () => {
        const opened = OpenedMeeting.of(new MeetingStore(), record);
        const fixture = scene([{ label: lake, mic: 0 }]);
        fixture.evidence.speaking = [{ tSec: 0, speaking: [], muted: [reed] }];
        const source = spyOn(opened, "sourceEvidence").mockResolvedValue(fixture.evidence);
        const config = spyOn(opened, "config");
        const entries = [{ speaker: lake, startSec: 100, text: "Hello." }];
        try {
            for (const [cap, expected] of [
                [110, [reed]],
                [90, []],
            ] as const) {
                config.mockResolvedValue(meetingsConfigSchema.parse({ global: { suggest: { mutedCarrySec: cap } } }));
                const evidence = await opened.evidence();
                expect(evidence).not.toBeNull();
                expect(lineEvidence(entries, evidence!)[0]?.muted ?? []).toEqual([...expected]);
            }
        } finally {
            config.mockRestore();
            source.mockRestore();
        }
    });
});

test("one acoustic observation per line serves the evidence rules", () => {
    const fixture = scene([
        { label: "Guest", mic: 0.1 },
        { label: "Guest", mic: 0.2 },
    ]);
    const observations: number[] = [];
    const share = Object.assign(fixture.share, {
        acoustic: (fromSec: number) => {
            observations.push(fromSec);
            return undefined;
        },
    });
    suggestItems({ ...base, ...fixture, energyMicShare: share });
    expect(observations).toEqual([0, 10]);
});

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

        // Both sides of the swap carry typed scores: the named speaker first, at the range's confidence, with R20.
        for (const speaker of [USER, "Bob Example"]) {
            const swap = swaps.find((item) => item.speaker === speaker);
            const scores = swap?.evidence?.candidateScores;
            expect(Array.isArray(scores) ? scores[0] : undefined).toMatchObject({
                speaker,
                confidence: 0.9,
                lines: 1,
                evidence: expect.arrayContaining([{ kind: "voice", rule: "R20" }]),
            });
        }
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
    test("opposed channels do not establish the strong call lines of a stuck stretch", () => {
        const lines: LineEvidence[] = Array.from(
            { length: 40 },
            (_, index): LineEvidence => ({
                index,
                startSec: index * 20,
                endSec: index * 20 + 5,
                label: "S1",
                text: "Words",
                present: ["Quill Example", "Lark Example"],
                speaking: index < 20 ? { "Quill Example": 1 } : {},
                energyMic: index < 20 ? 0.2 : 0.95,
                micShare: 0.7,
            })
        );
        expect(assessIndicator({ lines, selfName: USER }).ignored.size).toBe(0);
        expect(
            assessIndicator({ lines: lines.map((line) => ({ ...line, micShare: line.energyMic })), selfName: USER })
                .ignored.size
        ).toBe(lines.length);
    });
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
        // Failed reads between two good reads: the indicator is unknown there, never a repeated light (W3, I21).
        const gaps = lines.map((line) => ({
            ...line,
            speaking: line.index > 41 && line.index < 99 ? {} : line.speaking,
            ...(line.index > 41 && line.index < 99 ? { speakingUnknown: true } : {}),
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
        // Without attendance the only candidate would come from that same stuck indicator: nobody is named.
        expect(identifiedDepartures({ hints, lines: shown, selfName: USER })).toEqual([
            { name: "Carol Example", atSec: 0, reason: "indicator" },
        ]);
        expect(identifiedDepartures({ hints, lines: shown, selfName: USER, ignoredIndicator: new Set([0]) })).toEqual(
            []
        );
        // A goodbye under Carol's own label names its label, so the suggest rules keep that label's leave hint.
        const own = [{ ...hints[0]!, label: "Carol Example" }];
        expect(identifiedDepartures({ hints: own, lines: shown, selfName: USER, presence })).toEqual([
            { name: "Carol Example", atSec: 0, label: "Carol Example", reason: "indicator" },
        ]);
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

test("R3 an echo residual leaves a strong call line unnamed and its choices on the call", () => {
    const sample = scene([{ label: "Bob Example", mic: 0.02 }]);
    const audio = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 12));
    const acoustic = correlateEcho({ mic: audio, call: audio, rate: 1000 });
    const share = Object.assign(sample.share, { acoustic: () => acoustic });
    const found = ranges(suggestItems({ ...base, ...sample, energyMicShare: share }));
    expect(found).toHaveLength(1);
    expect(found[0]?.speaker).toBeUndefined();
    expect(found[0]?.candidates).toEqual(["Bob Example", "Carol Example"]);
    expect(found[0]?.rules).toContain("R18");
});

test("a matched call voice under a microphone tag still needs an eligible call input throughout the line", () => {
    const guest = "Fern Example";
    const visitor = "Pip Example";
    const fixture = scene(Array.from({ length: 4 }, () => ({ label: "Voice", mic: 1 })));
    fixture.evidence.speaking = [
        { tSec: 0, speaking: [], muted: [guest] },
        { tSec: 10, speaking: [], muted: [] },
    ];
    const match = (person: string) => ({
        person,
        model: "fixture",
        quality: "matched",
        candidates: [{ person, score: 0.85 }],
        reason: "cosine and margin passed",
    });
    const seated = meetingRecordSchema.parse({
        ...record,
        seats: { room: [USER, visitor], remote: [{ name: guest }] },
        evidence: {
            voice: {
                version: 1,
                source: "fixture.wav",
                enrolment: "fixture.json",
                lines: { 0: match(guest), 1: match(guest), 2: match(visitor), 3: match(guest) },
            },
        },
    });
    const found = ranges(
        suggestItems({
            ...base,
            ...fixture,
            record: seated,
            presence: [{ name: guest, fromSec: 0, toSec: 32 }],
            energyMicShare: () => 0.1,
        })
    );
    // Muted at 0, eligible at 10, room-only at 20, and a call stay ending inside the last line.
    expect(
        found.filter((item) => item.rules.includes(MeetingRule.VoiceEmbedding)).map((r) => [r.fromSec, r.speaker])
    ).toEqual([[10, guest]]);
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

    // One room line of 12 s is long enough to ask about, though the run starts and ends at that line's start.
    const long = [
        { index: 0, fromSec: 100, toSec: 112, label: "Room", text: lines[0].text, channel: { micShare: 0.9 } },
    ];
    expect(planByChannel({ lines: long, input }).questions).toHaveLength(1);
    expect(planByChannel({ lines: [{ ...long[0], toSec: 104 }], input }).questions).toHaveLength(0);
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

test("channel plans use microphone groups, a whole line's seats, and give each room question its range", () => {
    const text = "A sufficiently long transcript sentence.";
    const line = (index: number, micShare: number, toSec?: number) => ({
        index,
        fromSec: index * 10,
        ...(toSec === undefined ? {} : { toSec }),
        label: "Room",
        text,
        channel: { micShare },
    });
    const seats = {
        room: ["Alice", "Bob"],
        remote: [{ name: "Carol" }, { name: "Dan" }],
        microphones: [
            { id: "self", people: ["Alice"] },
            { id: "remote-room", label: "Room", people: ["Carol"] },
        ],
    };
    const grouped = planByChannel({ lines: [line(0, 0.95), line(1, 0.05)], seats, input: { label: "Room" } });
    expect(grouped.ranges.map((range) => [range.from, range.speaker])).toEqual([
        [0, "Alice"],
        [10, "Carol"],
    ]);

    // Carol leaves at 15 s and Dan joins then: a line from 10 s to 20 s has no one remote person throughout.
    const handover = {
        room: [],
        remote: [
            { name: "Carol", toSec: 15 },
            { name: "Dan", fromSec: 15 },
        ],
    };
    const crossing = planByChannel({ lines: [line(1, 0.05, 20)], seats: handover, input: { label: "Room" } });
    expect(crossing.ranges).toEqual([]);
    expect(crossing.unresolved).toHaveLength(1);
    expect(
        planByChannel({ lines: [line(1, 0.05, 14)], seats: handover, input: { label: "Room" } }).ranges[0]?.speaker
    ).toBe("Carol");

    const asked = planByChannel({
        lines: [line(0, 0.95, 12)],
        seats: { room: ["Alice", "Bob"], remote: [] },
        input: { label: "Room", askRoom: { minSec: 8, max: 2 } },
    });
    expect(asked.targets).toEqual([expect.objectContaining({ kind: "speaker-range", ref: "room-run-1", from: 0 })]);
    expect(asked.targets[0]).not.toHaveProperty("speaker");
    expect(asked.questions[0]?.decides).toEqual(["room-run-1"]);
});

test("a channel replacement stays on its label, applies with an empty plan, stamps, ends the round and is fenced", async () => {
    const store = new MeetingStore(new Storage(`channel-replace-${process.pid}`));
    const agent = { kind: "agent", harness: "fixture", session: null } as const;
    const journal = new DecisionJournal({ store, ledger: () => undefined });
    const record = await store.create(
        { title: "Replace fixture", start: START, createdBy: "new", seats: { room: ["Alice"], remote: [] } },
        { command: "test", change: "fixture" }
    );
    const range = (label: string, from: number) => ({
        kind: "speaker-range" as const,
        from,
        to: from,
        label,
        speaker: "Alice",
        confidence: 0.6,
        reason: "channel fixture",
    });
    const question = {
        kind: "question" as const,
        about: "speaker" as const,
        from: 0,
        to: 0,
        question: "Who speaks?",
        choices: ["Alice", "Bob"],
        decides: ["room-range"],
        reason: "channel fixture",
    };
    await journal.apply({
        meeting: record.id,
        actor: agent,
        action: { kind: "add", findings: [{ ...range("Room", 0), ref: "room-range" }, range("Other", 30), question] },
    });
    const replace = { by: "agent" as const, kinds: ["speaker-range" as const, "question" as const], label: "Room" };
    const fence = { seats: seatsFingerprint(store.read(record.id)!.seats) };
    const first = await journal.apply({
        meeting: record.id,
        actor: agent,
        action: { kind: "add", findings: [], replace, fence },
    });
    const statuses = () =>
        store
            .read(record.id)!
            .items.map((item) => [item.kind, item.kind === "speaker-range" ? item.label : "", item.status]);
    expect(statuses()).toEqual([
        ["speaker-range", "Room", "rejected"],
        ["speaker-range", "Other", "suggested"],
        ["question", "", "rejected"],
    ]);
    expect(first.entry?.decided).toEqual(["i1", "i3"]);
    expect(store.read(record.id)!.items[0]?.decision?.token).toBe(first.entry!.token);
    const log = readFileSync(join(store.folder(record.id), "questions.ndjson"), "utf8");
    expect(log).toContain('"questions-rejected"');

    await journal.revert({ meeting: record.id, token: first.entry!.token, actor: { kind: "cli" } });
    expect(statuses().map((row) => row[2])).toEqual(["suggested", "suggested", "suggested"]);

    await journal.apply({
        meeting: record.id,
        actor: { kind: "cli" },
        action: { kind: "set", seats: { room: ["Alice", "Bob"], remote: [] } },
    });
    await expect(
        journal.apply({ meeting: record.id, actor: agent, action: { kind: "add", findings: [], replace, fence } })
    ).rejects.toThrow("seats");
    await expect(
        journal.apply({ meeting: record.id, actor: agent, action: { kind: "add", findings: [] } })
    ).rejects.toThrow("at least one finding");
});

test("the echo lag of a preview is searched on a 2 kHz copy, and a too short voice sample is an unknown voice", async () => {
    expect(Array.from(decimate(Float32Array.from([1, 3, 5, 7, 2]), 2))).toEqual([2, 6]);
    await expect(
        embedVoice({ audioPath: "/fixture/none.wav", channel: 0, fromSec: 0, toSec: 1 })
    ).rejects.toBeInstanceOf(VoiceUnavailableError);
});

test("line evidence with a window measures only the lines that start in it, at their whole-transcript index", () => {
    const fixture = scene(Array.from({ length: 6 }, () => ({ label: "Room", mic: 1 })));
    const windowed = lineEvidence(fixture.meeting.transcript, fixture.evidence, undefined, undefined, {
        window: { fromSec: 20, toSec: 30 },
    });
    expect(windowed.map((line) => [line.index, line.startSec])).toEqual([
        [2, 20],
        [3, 30],
    ]);
});

test("byChannel decides on the measured microphone share, not the rounded one shown", async () => {
    const store = new MeetingStore(new Storage(`by-channel-precision-${process.pid}`));
    const record = await store.create(
        { title: "Precision", start: START, createdBy: "new", seats: { room: ["Alice"], remote: [{ name: "Carol" }] } },
        { command: "test", change: "fixture" }
    );
    const fixture = scene([{ label: "Room", mic: 0 }]);
    fixture.evidence.segments = [
        { startSec: 0, endSec: 2.004, channel: "mic" },
        { startSec: 2.004, endSec: 10, channel: "system" },
    ];
    const load = spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue(fixture.meeting);
    const evidence = spyOn(OpenedMeeting.prototype, "evidence").mockResolvedValue(fixture.evidence);
    try {
        const plan = await attributeByChannel({ store, record, input: { label: "Room", minChars: 0, dryRun: true } });
        expect(plan.ranges).toEqual([]);
        expect(plan.mixed).toHaveLength(1);
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

test("a first manual stay keeps the roster's presence, and a time edit keeps a placement changed while it waited", async () => {
    const storage = new Storage(`room-people-roster-${process.pid}`);
    const store = new MeetingStore(storage);
    mkdirSync(store.folder(record.id), { recursive: true });
    writeFileSync(
        join(store.folder(record.id), "meeting.json"),
        SafeJSON.stringify({
            ...record,
            end: "2026-11-03T13:00:00Z",
            participants: [
                ...record.participants.map((person) => ({ ...person, firstSeenSec: 0 })),
                {
                    name: "Fay Example",
                    from: ["wisprflow"],
                    stays: [{ fromSec: 30, toSec: 900, source: "attendance" }],
                },
            ],
            seats: { room: ["Gil Example"], remote: [] },
        })
    );

    await editMeetingPerson({
        store,
        meeting: record.id,
        edit: { action: "add", name: "Dana Example", atMic: true, fromSec: 10, toSec: 100 },
    });
    expect(new MeetingStore(storage).resolve(record.id)!.attendance!.people).toEqual([
        { name: USER, fromSec: 0, toSec: 3600 },
        { name: "Fay Example", fromSec: 30, toSec: 900 },
        { name: "Dana Example", fromSec: 10, toSec: 100, joinedAtExact: true, leftAtExact: true },
    ]);

    // Another edit moves Gil to a remote device while this time-only edit waits for the record.
    const update = store.update.bind(store);
    spyOn(store, "update").mockImplementationOnce(async (id, change, mutate) => {
        await update(id, { command: "test", change: "move Gil remote" }, (next) => {
            next.seats = { room: [], remote: [{ name: "Gil Example" }] };
        });
        return update(id, change, mutate);
    });
    await editMeetingPerson({
        store,
        meeting: record.id,
        edit: { action: "add", name: "Gil Example", fromSec: 5, toSec: 50 },
    });
    const saved = new MeetingStore(storage).resolve(record.id)!;
    expect(saved.seats!.room).not.toContain("Gil Example");
    expect(saved.seats!.remote.map((seat) => seat.name)).toContain("Gil Example");
});

// The features stream through ffmpeg, which a runner without it (CI) lacks.
test.skipIf(!Bun.which("ffmpeg"))(
    "streamed synthetic stereo voice features preserve pitch, level, silence and anchored clusters",
    async () => {
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
            wav.writeInt16LE(
                Math.round(16000 * Math.sin((2 * Math.PI * (i < rate ? 125 : 250) * i) / rate)),
                44 + i * 4
            );
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
    }
);

/** A line channel's voice features: only the loudness and the pitch differ between the clustering tests. */
function voiceFeature({ pitchHz, rms = 0.05 }: { pitchHz: number; rms?: number }) {
    return { rms, lowBandShare: 0.5, tilt: 0.1, pitchHz, voicedShare: 1 };
}

test("a voice cluster names an unanchored line only on a clear, near match", () => {
    const line = (index: number, pitchHz: number) => ({
        index,
        channels: [voiceFeature({ pitchHz }), voiceFeature({ pitchHz, rms: 0.001 })],
    });
    const named = (lines: Array<ReturnType<typeof line>>, anchors: Array<[number, string]>) =>
        clusterVoices({ lines, voices: 2, channel: 0, anchors: new Map(anchors) }).map((one) => one.cluster?.speaker);

    // Two anchors with one voice tie: the line between them stays unnamed, the anchors keep their names.
    expect(
        named(
            [line(0, 150), line(1, 150), line(2, 150)],
            [
                [0, "Alice"],
                [1, "Bob"],
            ]
        )
    ).toEqual(["Alice", "Bob", undefined]);
    // Far from both anchored voices: an outlier is nobody yet; a line near Bob is Bob.
    expect(
        named(
            [line(0, 120), line(1, 210), line(2, 205), line(3, 400)],
            [
                [0, "Alice"],
                [1, "Bob"],
            ]
        )
    ).toEqual(["Alice", "Bob", "Bob", undefined]);
});

test("a confirmed line anchors only the channel that carries its voice", () => {
    const anchoredRecord = meetingRecordSchema.parse({
        ...record,
        items: [
            {
                id: "i1",
                kind: "speaker-range",
                label: "Voice",
                fromSec: 0,
                toSec: 0,
                speaker: "Remy Example",
                status: "confirmed",
                rules: [],
                suggestedAt: START,
            },
        ],
    });
    const features = [
        { index: 0, channels: [voiceFeature({ rms: 0.01, pitchHz: 150 }), voiceFeature({ rms: 0.1, pitchHz: 150 })] },
        {
            index: 1,
            channels: [voiceFeature({ rms: 0.05, pitchHz: 120 }), voiceFeature({ rms: 0.001, pitchHz: 120 })],
        },
    ];
    const clustered = anchoredMeetingVoices({
        record: anchoredRecord,
        transcript: [
            { speaker: "Voice", startSec: 0, text: "From the call." },
            { speaker: "Room", startSec: 5, text: "In the room." },
        ],
        features,
        voices: 2,
        channel: 0,
        micChannel: 0,
    });

    expect(clustered.map((line) => line.cluster?.speaker)).toEqual([undefined, undefined]);
    expect(
        anchoredMeetingVoices({
            record: anchoredRecord,
            transcript: [{ speaker: "Voice", startSec: 0, text: "From the call." }],
            features: features.slice(0, 1),
            voices: 1,
            channel: 1,
            micChannel: 0,
        })[0]?.cluster?.speaker
    ).toBe("Remy Example");
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

const roomRecord = meetingRecordSchema.parse({
    ...record,
    seats: { room: [USER, "Dana Example"], remote: [{ name: "Bob Example" }] },
});
const danaCluster = (index: number) => ({
    index,
    channels: [{ rms: 0, pitchHz: null, lowBandShare: 0, tilt: 0, voicedShare: 0 }],
    cluster: { id: 0, confidence: 0.9, speaker: "Dana Example" },
});

test("a confirmed room voice keeps its person through the shared-microphone fallbacks", () => {
    const fixture = scene([
        { label: "Bob Example", mic: 0.95 },
        { label: "Bob Example", mic: 0.95 },
    ]);
    const share: AcousticShare = Object.assign(fixture.share, {
        voice: () => ({
            model: "fixture:v1",
            quality: "matched" as const,
            person: "Dana Example",
            candidates: [{ person: "Dana Example", score: 0.9 }],
            reason: "threshold and margin met",
        }),
    });
    const found = ranges(
        suggestItems({
            ...base,
            record: roomRecord,
            meeting: fixture.meeting,
            evidence: fixture.evidence,
            energyMicShare: share,
        })
    );

    expect(found.every((item) => item.speaker === "Dana Example" && item.rules.includes("voice"))).toBe(true);
    expect(found.length).toBeGreaterThan(0);
});

test("an anchored voice cluster names a room person only where the channels agree, and stays a question", () => {
    const shared = scene([{ label: USER, mic: 0.95 }]);
    const promoted = ranges(
        suggestItems({
            ...base,
            record: roomRecord,
            meeting: shared.meeting,
            evidence: shared.evidence,
            energyMicShare: shared.share,
            voice: [danaCluster(0)],
        })
    );
    expect(promoted[0]).toMatchObject({ speaker: "Dana Example", confidence: 0.7, evidence: { listen: true } });
    expect(promoted[0]?.candidates).toContain(USER);

    // The tagged channel says microphone, the calibrated energy says call: the cluster does not settle that conflict.
    const conflict = scene([{ label: "Bob Example", mic: 0.95 }]);
    const kept = ranges(
        suggestItems({
            ...base,
            record: roomRecord,
            meeting: conflict.meeting,
            evidence: conflict.evidence,
            energyMicShare: () => 0.2,
            voice: [danaCluster(0)],
        })
    );
    expect(kept[0]?.speaker).toBeUndefined();
    expect(kept[0]?.candidates).toContain("Dana Example");
});

test("confirmed offline voice evidence decides remote lines without inheriting a mic label", () => {
    const fixture = scene([
        { label: "Bob Example", mic: 0.1 },
        { label: "Bob Example", mic: 0.1 },
    ]);
    const share: AcousticShare = Object.assign(fixture.share, {
        voice: () => ({
            model: "fixture:v1",
            quality: "matched" as const,
            person: "Carol Example",
            candidates: [
                { person: "Carol Example", score: 0.85 },
                { person: "Bob Example", score: 0.2 },
            ],
            reason: "threshold and margin met",
        }),
    });
    const result = ranges(
        suggestItems({ ...base, meeting: fixture.meeting, evidence: fixture.evidence, energyMicShare: share })
    );
    expect(
        result.some(
            (item) => item.speaker === "Carol Example" && item.rules.includes("voice") && (item.confidence ?? 0) >= 0.9
        )
    ).toBe(true);
    const unknown: AcousticShare = Object.assign(fixture.share, {
        voice: () => ({ model: "fixture:v1", quality: "unknown" as const, candidates: [], reason: "ambiguous" }),
    });
    expect(
        ranges(
            suggestItems({ ...base, meeting: fixture.meeting, evidence: fixture.evidence, energyMicShare: unknown })
        ).some((item) => item.rules.includes("voice"))
    ).toBe(false);
});
