import { describe, expect, test } from "bun:test";
import { sha256Json } from "@genesiscz/utils/hash";
import {
    freezeRoomCall,
    type HoldoutManifest,
    measureRoomCall,
    type RoomCallPrediction,
    type RoomCallSnapshot,
} from "./room-call-metrics";

const owner = "Wren Vale";
const guest = "Iris Pike";
const remote = "Tobin Lake";
const source = { rootMeeting: "orchard", audioSha256: "a".repeat(64) };
const external = {
    id: "vs_independent",
    meeting: "garden-copy",
    rootMeeting: "garden",
    audioSha256: "b".repeat(64),
    person: guest,
    fromSec: 4,
    toSec: 8,
    origin: "confirm" as const,
};

function fixture(speakers: string[]) {
    const entries = speakers.map((speaker, i) => ({
        id: `line-${i}`,
        startSec: Math.floor(i / 2),
        endSec: Math.floor(i / 2) + 1,
        speaker,
    }));
    const reference = { meeting: source.rootMeeting, entries };
    const keys = entries.map(({ id, startSec, endSec }) => ({ id, startSec, endSec }));
    const candidateSeats = { room: [owner, guest], remote: [{ name: remote }] };
    const holdout: HoldoutManifest = {
        source,
        referenceHash: sha256Json(reference),
        people: { owner, room: [guest], remote: [remote] },
        roomTarget: guest,
        lateRemote: { person: remote, fromSec: 0, toSec: 12 },
        mute: { lastPositiveSec: 1, firstOmittedSec: 3 },
        lines: keys,
        originalRemote: keys.filter((_, index) => speakers[index] === remote),
        history: [],
        libraryHash: "c".repeat(64),
        runs: {
            baseline: { revision: "1111111", seats: null },
            candidate: { revision: "2222222", seats: candidateSeats },
        },
    };
    const rows: RoomCallPrediction[] = keys.map((key, i) => ({ ...key, named: speakers[i], choices: [] }));
    const common = {
        source,
        holdoutHash: sha256Json(holdout),
        libraryHash: holdout.libraryHash,
        configHash: "d".repeat(64),
        inputHash: "e".repeat(64),
        training: [external],
        cachedDecisions: 0,
        temporarySeeds: 0,
        muteHint: { person: guest, included: 2, explicit: 3, missing: 4 },
        warnings: [],
    };
    const baseline: RoomCallSnapshot = { ...common, ...holdout.runs.baseline, rows };
    const candidate: RoomCallSnapshot = {
        ...structuredClone(common),
        ...holdout.runs.candidate,
        rows: structuredClone(rows),
    };
    return { reference, baseline, candidate, holdout };
}

function offer(names: string[], scores: Array<number | null> = []) {
    return names.map((person, i) => ({ person, score: scores[i] ?? null }));
}

describe("held-out room/call measurement", () => {
    test("freezes the archived remote loss before the candidate exists, including equal-time siblings", () => {
        const { reference, holdout } = fixture([remote, remote, guest]);
        const question = {
            ...reference.entries[0]!,
            speaker: "[open]",
            band: "open",
            confidence: 0.4,
            unclear: { readings: [remote, guest] },
        };
        const head = { ...reference, entries: [reference.entries[2], question, reference.entries[1]] };
        const result = freezeRoomCall({
            reference,
            scenario: holdout,
            remote,
            archives: [
                { revision: "old", transcript: reference },
                { revision: "lost", transcript: head },
                { revision: "recovered", transcript: reference },
            ],
        });
        expect(result.originalRemote).toEqual([holdout.lines[0]!]);
        expect(result.history.map((run) => run.correctOnOriginalRemote)).toEqual([1, 0, 1]);
    });
    test("offering the room guest on all 1518 lines fails the blanket-offer control", () => {
        const input = fixture(Array.from({ length: 1518 }, (_, i) => (i < 167 ? guest : i < 800 ? remote : owner)));
        for (const row of input.candidate.rows) {
            row.named = null;
            row.choices = offer([remote, guest], [0.8, 0.2]);
        }
        const result = measureRoomCall(input);
        expect(result.targets.room).toMatchObject({ correctNameOrFirst: 0, met: false });
        expect(result.controls.blanketRoomOffer).toBe(true);
        expect(result.candidate.populations.room.counts.offeredOnly).toBe(167);
        expect(result.candidate.falseOffers[guest]).toBe(1351);
        expect(result.candidate.wrongFirst[remote]).toBe(885);
        // A candidate can also game a top-one target by putting that guest first everywhere.
        for (const row of input.candidate.rows) {
            row.choices = offer([guest], [1]);
        }
        const gaming = measureRoomCall(input);
        expect(gaming.targets.room.correctNameOrFirst).toBe(167);
        expect(gaming.controls.blanketRoomOffer).toBe(true);
        expect(gaming.qualityPassed).toBe(false);
        input.candidate.rows[0]!.choices = [];
        expect(measureRoomCall(input).controls.blanketRoomOffer).toBe(true);
    });

    test("six exclusive outcomes sum to the denominator; ties never earn first and unknown truth stays separate", () => {
        const input = fixture([guest, guest, guest, guest, guest, guest, guest, owner, remote, "[unclear]"]);
        const rows = input.candidate.rows;
        rows[1]!.named = owner;
        const choices = [
            offer([remote, guest], [0.2, 0.8]),
            offer([owner, guest], [0.8, 0.2]),
            offer([remote]),
            [],
            offer([guest, remote], [0.7, 0.7]),
        ];
        for (const [i, offered] of choices.entries()) {
            Object.assign(rows[i + 2]!, { named: null, choices: offered });
        }
        input.candidate.rows.reverse();
        const result = measureRoomCall(input);
        const room = result.candidate.populations.room;
        expect(room.denominator).toBe(7);
        expect(room.counts).toEqual({
            namedCorrect: 1,
            namedWrong: 1,
            firstChoiceCorrect: 1,
            offeredOnly: 2,
            unofferedReview: 1,
            abstained: 1,
        });
        expect(room.tiedFirst).toBe(1);
        expect(result.candidate.speakers[guest]?.namedAs[owner]).toBe(1);
        expect(result.candidate.wrongFirst).toEqual({ [owner]: 1, [remote]: 1 });
        expect(result.unscored.map((row) => row.id)).toEqual(["line-9"]);
    });

    test("one lost remote name survives a compensating gain, including its ID and mute-read cohort", () => {
        const input = fixture([remote, owner, remote, guest, remote, guest, remote, owner]);
        Object.assign(input.candidate.rows[0]!, { named: null, choices: offer([guest, remote]) });
        input.baseline.rows[6]!.named = guest;
        input.candidate.rows[4]!.named = guest;
        const result = measureRoomCall(input);
        expect(result.cohorts.originalRemote.ids).toEqual(["line-0", "line-2", "line-4", "line-6"]);
        expect(result.cohorts.originalRemote.correctNameToReview).toEqual(["line-0"]);
        expect(result.cohorts.originalRemote.correctNameToWrong).toEqual(["line-4"]);
        expect(result.cohorts.originalRemote.wrongNameDelta).toBe(0);
        expect(result.cohorts.beforeMuteRead.correctNameToReview).toEqual(["line-0"]);
        expect(result.cohorts.betweenMuteReads.correctNameToWrong).toEqual(["line-4"]);
        expect(result.cohorts.afterMuteRead.recoveredName).toEqual(["line-6"]);
        expect(result.cohorts.lateRemote.correctNameToReview).toEqual(["line-0"]);
        expect(result.targets.remote.met).toBe(false);
    });

    test("duplicate IDs, missing lines, shifted spans and an altered reference fail the join", () => {
        for (const defect of ["duplicate", "missing", "shifted", "reference", "cohort", "holdout"] as const) {
            const input = fixture([owner, guest, remote]);
            if (defect === "duplicate") {
                input.candidate.rows[1]!.id = input.candidate.rows[0]!.id;
            } else if (defect === "missing") {
                input.baseline.rows.pop();
            } else if (defect === "shifted") {
                input.candidate.rows[0]!.endSec += 0.5;
            } else if (defect === "reference") {
                input.reference.entries[1]!.speaker = owner;
            } else if (defect === "holdout") {
                input.holdout.lines.splice(1, 1);
                input.baseline.holdoutHash = input.candidate.holdoutHash = sha256Json(input.holdout);
            } else {
                input.holdout.originalRemote[0] = input.holdout.lines[0]!;
                input.baseline.holdoutHash = input.candidate.holdoutHash = sha256Json(input.holdout);
            }
            expect(() => measureRoomCall(input)).toThrow(/duplicate|missing|span|reference|remote cohort/i);
        }
    });

    test("copied audio, shared root, cached decisions, temporary seeds and unfrozen inputs fail closed", () => {
        for (const defect of ["audio", "root", "cache", "seed", "library", "seats", "version"] as const) {
            const input = fixture([owner, guest, remote]);
            const snap = input.candidate;
            if (defect === "audio") {
                snap.training[0]!.audioSha256 = source.audioSha256;
            } else if (defect === "root") {
                snap.training[0]!.rootMeeting = source.rootMeeting;
            } else if (defect === "cache") {
                snap.cachedDecisions = 1;
            } else if (defect === "seed") {
                snap.temporarySeeds = 1;
            } else if (defect === "library") {
                snap.libraryHash = "f".repeat(64);
            } else if (defect === "seats") {
                snap.seats = null;
            } else {
                snap.revision = "3333333";
            }
            expect(() => measureRoomCall(input)).toThrow(/overlap|cached|seed|library|seats|revision/i);
        }
    });
});
