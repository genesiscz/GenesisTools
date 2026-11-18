import { expect, test } from "bun:test";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import type { SpeakerFacts } from "./speaker-eligibility";

// Load inside each case so that the orchestrator's base replay reports each missing eligibility check separately.
const eligibility = () => import("./speaker-eligibility");
const room = "Quill Example";
const remote = "Lark Example";
const guest = "Finch Example";
const desk = "Table input";
const line = { index: 0, fromSec: 20, toSec: 21 };
const facts: SpeakerFacts = {
    people: [room, remote, guest],
    seats: { room: [room], remote: [{ name: remote }] },
    callStays: [room, remote, guest].map((name) => ({ name, fromSec: 0, toSec: 80 })),
    speaking: {},
};

test("channel provenance and the call-majority and naming thresholds agree on a complete line", async () => {
    const { speakersFor, isPredominantlyCall, isStrongCallForNaming } = await eligibility();
    for (const [readings, side, source, majority, strong] of [
        [{ micShare: 0.35 }, "call", "segments", true, true],
        [{ energyMic: 0.350001 }, "call", "energy", true, false],
        [{ energyMic: 0.49999 }, "call", "energy", true, false],
        [{ micShare: 0.5 }, "mixed", "segments", false, false],
        [{}, "unknown", "none", false, false],
        [{ energyMic: 0.2, micShare: 0.7 }, "mixed", "both", false, false],
        [{ energyMic: 0.7, micShare: 0.2 }, "mixed", "both", false, false],
        [{ energyMic: Number.NaN, micShare: 0.25 }, "call", "segments", true, true],
        [{ energyMic: 0.1, micShare: 0.4 }, "call", "both", true, false],
    ] as const) {
        const result = speakersFor(line, { ...facts, ...readings, muted: [remote] });
        expect(result.channel).toMatchObject({ side, source });
        expect(isPredominantlyCall(result.channel)).toBe(majority);
        expect(isStrongCallForNaming(result.channel)).toBe(strong);
        expect(result.choices.includes(remote)).toBe(!majority);
        expect(result.reviewOnly).toBe(true);
    }
});

test("a muted room voice remains eligible on the mic before, during and after its call stay", async () => {
    const { speakersFor } = await eligibility();
    const input = { ...facts, callStays: [{ name: room, fromSec: 10, toSec: 15 }], muted: [room] };
    for (const fromSec of [8, 10, 14, 15, 20]) {
        const span = { ...line, fromSec, toSec: fromSec + 1 };
        expect(speakersFor(span, { ...input, micShare: 1 }).choices).toEqual([room]);
        const call = speakersFor(span, { ...input, micShare: 0 });
        expect(call.choices).toEqual([remote, guest]);
        expect(call.excluded.map((x) => x.person)).toContain(room);
    }
});

test("two close yes turns on distinct inputs keep independent choices with an unmuted or unread room laptop", async () => {
    const { speakersFor } = await eligibility();
    const turns = [
        { ...line, text: "yes", micShare: 0.9 },
        { index: 1, fromSec: 20.16, toSec: 21.16, text: "yes", micShare: 0.1 },
    ];
    for (const muted of [[], undefined]) {
        expect(turns.map((turn) => speakersFor(turn, { ...facts, micShare: turn.micShare, muted }).choices)).toEqual([
            [room],
            [remote, guest],
        ]);
    }
});

test("a mapped transmitting account offers only its human occupants regardless of their personal call state", async () => {
    const { speakersFor } = await eligibility();
    const other = "Pip Example";
    const input: SpeakerFacts = {
        ...facts,
        people: [room, desk, guest, other],
        seats: {
            room: [room, { name: other, fromSec: 12, toSec: 40 }],
            remote: [{ name: guest }],
            microphones: [{ id: "table", deviceId: desk, people: [room, other] }],
        },
        callStays: [
            { name: desk, fromSec: 10, toSec: 50 },
            { name: room, fromSec: 0, toSec: 10 },
        ],
        energyMic: 0.1,
        muted: [room, other],
        speaking: { [desk]: 1 },
    };
    const call = speakersFor(line, input);
    expect(call.choices).toEqual([room, other]);
    expect(call.reviewOnly).toBe(true);
    expect(speakersFor(line, { ...input, endpoint: "table", speaking: {} }).choices).toEqual([room, other]);
    expect(speakersFor(line, { ...input, muted: [desk] }).choices).toEqual([]);
    expect(speakersFor({ ...line, fromSec: 49, toSec: 51 }, input).choices).toEqual([]);
    expect(speakersFor({ ...line, fromSec: 39, toSec: 41 }, input)).toMatchObject({
        choices: [room],
        reviewOnly: true,
    });
    for (const loss of [{ speakingUnknown: true }, { ignoredIndicator: true }]) {
        expect(speakersFor(line, { ...input, ...loss }).choices).toEqual([guest]);
    }
    expect(speakersFor(line, { ...input, energyMic: 1, endpoint: "unmapped-input" }).choices).toEqual([]);
});

test("occluded and ignored speaking observations are distinct from known silence and a known speaker", async () => {
    const { speakingStateFor } = await eligibility();
    expect(speakingStateFor({ speaking: {} })).toEqual({ kind: "empty" });
    expect(speakingStateFor({ speaking: {}, speakingUnknown: true })).toEqual({ kind: "unknown" });
    expect(speakingStateFor({ speaking: { [remote]: 2 }, ignoredIndicator: true })).toEqual({ kind: "ignored" });
    expect(speakingStateFor({ speaking: { [remote]: 2 } })).toEqual({ kind: "speaking", names: [remote] });
});

test("room and call choices use the whole half-open seat and attendance intervals", async () => {
    const { speakersFor } = await eligibility();
    const input: SpeakerFacts = {
        people: [room, remote],
        speaking: {},
        seats: { room: [{ name: room, fromSec: 60, toSec: 120 }], remote: [{ name: room, toSec: 60 }] },
        callStays: [
            { name: room, fromSec: 0, toSec: 80 },
            { name: remote, fromSec: 50, toSec: 60 },
            { name: remote, fromSec: 61, toSec: 75 },
        ],
    };
    const choices = (fromSec: number, toSec: number, micShare: number) =>
        speakersFor({ index: 0, fromSec, toSec }, { ...input, micShare }).choices;
    expect(choices(59, 60, 0)).toEqual([room, remote]);
    expect(choices(59, 61, 1)).toEqual([]);
    expect(choices(59, 61, 0)).toEqual([]);
    expect(choices(60, 61, 1)).toEqual([room]);
    expect(choices(60, 61, 0)).toEqual([]);
    expect(choices(90, 91, 1)).toEqual([room]);
    expect(choices(120, 121, 1)).toEqual([]);
});

test("a quiet roster guest returns after unmute, positive speaking, expiry or a line crossing the mute boundary", async () => {
    const { speakersFor } = await eligibility();
    const starts = [1, 4, 5, 10, 598, 605, 609, 611, 615, 620];
    const lines = lineEvidence(
        starts.map((startSec) => ({ startSec, speaker: "S1", text: "Yes" })),
        {
            segments: [{ startSec: 0, endSec: 700, channel: "system" }],
            speaking: [
                { tSec: 0, speaking: [], muted: [guest] },
                { tSec: 3, speaking: [], speakingUnknown: true },
                { tSec: 5, speaking: [guest] },
                { tSec: 10, speaking: [], muted: [guest] },
                { tSec: 615, speaking: [], muted: [guest] },
                { tSec: 617, speaking: [], muted: [] },
            ],
        }
    );
    const offer = lines.map((row) =>
        speakersFor(
            { index: row.index, fromSec: row.startSec, toSec: row.endSec },
            {
                ...row,
                people: [remote, guest],
            }
        )
    );
    expect(offer.map((result) => result.choices.includes(guest))).toEqual([
        false,
        false,
        true,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
    ]);
    expect(offer.every((result) => result.reviewOnly)).toBe(true);
});
