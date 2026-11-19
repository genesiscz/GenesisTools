import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Json } from "@genesiscz/utils/hash";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingStore, voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { meetingSeatsSchema } from "@genesiscz/utils/meetings/seats";
import { z } from "zod";

const name = z.string().trim().min(1).normalize();
const time = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({ rootMeeting: name, audioSha256: digest });
const lineKey = z.object({ id: z.string().min(1), startSec: time, endSec: time });
type Key = z.infer<typeof lineKey>;
const referenceEntry = lineKey.extend({
    speaker: z.string(),
    guess: z.boolean().optional(),
    band: z.enum(["open", "guess", "applied", "confirmed"]).optional(),
    unclear: z.object({ readings: z.array(z.string()) }).optional(),
    confidence: z.number().optional(),
});
export const roomCallTranscript = z.object({ meeting: name, entries: z.array(referenceEntry).min(1) });
const run = z.object({ revision: name, seats: meetingSeatsSchema.nullable() });
export const roomCallScenario = z.object({
    source,
    people: z.object({ owner: name, room: z.array(name), remote: z.array(name) }),
    roomTarget: name,
    lateRemote: z.object({ person: name, fromSec: time, toSec: time }),
    mute: z.object({ lastPositiveSec: time, firstOmittedSec: time }),
    runs: z.object({ baseline: run, candidate: run }),
    libraryHash: digest,
});
export const roomCallHoldout = roomCallScenario.extend({
    referenceHash: digest,
    lines: z.array(lineKey).min(1),
    originalRemote: z.array(lineKey),
    history: z.array(z.object({ revision: name, hash: digest, correctOnOriginalRemote: count })),
});
export type HoldoutManifest = z.infer<typeof roomCallHoldout>;
const prediction = lineKey.extend({
    named: name.nullable(),
    choices: z.array(z.object({ person: name, score: z.number().finite().min(0).max(1).nullable() })),
});
export type RoomCallPrediction = z.infer<typeof prediction>;
const trainingSample = z.object({
    id: name,
    meeting: name,
    rootMeeting: name,
    audioSha256: digest,
    person: name,
    fromSec: time,
    toSec: time,
    origin: z.enum(["answer", "confirm", "enrol", "legacy"]),
});
const snapshotSchema = run.extend({
    source,
    holdoutHash: digest,
    libraryHash: digest,
    configHash: digest,
    inputHash: digest,
    runtime: z.object({ bun: name, model: z.string(), modelHash: digest }).optional(),
    training: z.array(trainingSample),
    cachedDecisions: count,
    temporarySeeds: count,
    muteHint: z.object({ person: name, included: count, explicit: count, missing: count }),
    undecidedSeatPreview: z
        .array(z.object({ name, seat: z.enum(["room", "remote", "unsure"]), reason: z.string() }))
        .optional(),
    warnings: z.array(z.string()),
    rows: z.array(prediction),
});
export type RoomCallSnapshot = z.infer<typeof snapshotSchema>;

function indexed<T extends Key>(rows: T[], label: string) {
    const result = new Map<string, T>();
    for (const row of rows) {
        if (result.has(row.id)) {
            throw new Error(`Duplicate source line in ${label}: ${row.id}`);
        }
        if (row.endSec <= row.startSec) {
            throw new Error(`Invalid span in ${label}: ${row.id}`);
        }
        result.set(row.id, row);
    }
    return result;
}

function aligned<T extends Key>(index: Map<string, T>, key: Key): T {
    const row = index.get(key.id);
    if (!row) {
        throw new Error(`Missing source line: ${key.id}`);
    }
    if (row.startSec !== key.startSec || row.endSec !== key.endSec) {
        throw new Error(`Source line span changed: ${key.id}`);
    }
    return row;
}

function exactRows<T extends Key>(keys: Key[], rows: T[], label: string) {
    const byId = indexed(rows, label);
    for (const key of keys) {
        aligned(byId, key);
    }
    if (byId.size !== keys.length) {
        throw new Error(`Extra source lines in ${label}`);
    }
    return byId;
}

function plainSpeaker(row: z.infer<typeof referenceEntry>) {
    return row.guess || row.unclear || row.band === "open" || row.band === "guess"
        ? undefined
        : row.speaker.trim().normalize();
}

/** Reconstruct the historic loss once, before either experimental output exists. */
export function freezeRoomCall(input: {
    reference: unknown;
    scenario: z.infer<typeof roomCallScenario>;
    remote: string;
    archives: Array<{ revision: string; transcript: unknown }>;
}): HoldoutManifest {
    const ref = roomCallTranscript.parse(input.reference);
    const scenario = roomCallScenario.parse(input.scenario);
    if (
        input.archives.length !== 3 ||
        ref.meeting !== scenario.source.rootMeeting ||
        !scenario.people.remote.includes(input.remote)
    ) {
        throw new Error(
            "Freeze requires master, head and carry-forward columns and the reference meeting's remote speaker"
        );
    }
    indexed(ref.entries, "reference");
    const columns = input.archives.map(({ transcript, revision }) =>
        exactRows(ref.entries, roomCallTranscript.parse(transcript).entries, revision)
    );
    const keys = ref.entries.map(({ id, startSec, endSec }) => ({ id, startSec, endSec }));
    const originalRemote = keys.filter((key, index) => {
        const lost = aligned(columns[1]!, key);
        const choices = lost.unclear?.readings ?? [];
        return (
            plainSpeaker(ref.entries[index]!) === input.remote &&
            plainSpeaker(aligned(columns[0]!, key)) === input.remote &&
            lost.band === "open" &&
            lost.confidence === 0.4 &&
            // A 0.4 question that offers the remote and the room guest; 37 of the frozen 123 also offered a third person.
            choices.includes(input.remote) &&
            choices.includes(scenario.roomTarget)
        );
    });
    return {
        ...scenario,
        referenceHash: sha256Json(input.reference),
        lines: keys,
        originalRemote,
        history: input.archives.map(({ revision, transcript }, i) => ({
            revision,
            hash: sha256Json(transcript),
            correctOnOriginalRemote: originalRemote.filter(
                (key) => plainSpeaker(aligned(columns[i]!, key)) === input.remote
            ).length,
        })),
    };
}

function validateRun(input: {
    arm: "baseline" | "candidate";
    snap: RoomCallSnapshot;
    manifest: HoldoutManifest;
    holdoutHash: string;
}) {
    const { arm, snap, manifest } = input;
    if (snap.holdoutHash !== input.holdoutHash || !isDeepStrictEqual(snap.source, manifest.source)) {
        throw new Error(`${arm} uses a different holdout or source recording`);
    }
    if (snap.revision !== manifest.runs[arm].revision || !isDeepStrictEqual(snap.seats, manifest.runs[arm].seats)) {
        throw new Error(`${arm} revision or seats differ from the frozen run`);
    }
    if (snap.libraryHash !== manifest.libraryHash) {
        throw new Error(`${arm} library differs from the frozen library`);
    }
    if (snap.cachedDecisions || snap.temporarySeeds) {
        throw new Error(`${arm} contains cached decisions or temporary seeds`);
    }
    for (const sample of snap.training) {
        if (
            sample.audioSha256 === snap.source.audioSha256 ||
            [sample.rootMeeting, sample.meeting].includes(snap.source.rootMeeting)
        ) {
            throw new Error(`Train/test overlap in ${arm}: ${sample.id}`);
        }
        if (sample.toSec <= sample.fromSec) {
            throw new Error(`Invalid training interval: ${sample.id}`);
        }
    }
    if (snap.muteHint.person !== manifest.roomTarget || snap.muteHint.included > snap.muteHint.explicit) {
        throw new Error("Mute hint does not describe the frozen room target's explicit reads");
    }
}

function counts() {
    return { namedCorrect: 0, namedWrong: 0, firstChoiceCorrect: 0, offeredOnly: 0, unofferedReview: 0, abstained: 0 };
}
type Outcome = keyof ReturnType<typeof counts>;

function classification(row: RoomCallPrediction, speaker: string) {
    const choices = row.choices.map((choice) => choice.person);
    if (new Set(choices).size !== choices.length || (row.named !== null && choices.length)) {
        throw new Error(`Ambiguous named/review prediction or duplicate choice: ${row.id}`);
    }
    // An unscored menu is unordered. A sole option is unambiguous; an equal top score has no winner.
    const best = Math.max(...row.choices.map((choice) => choice.score ?? -1));
    const leaders = row.choices.filter((choice) => (choice.score ?? -1) === best);
    const first = leaders.length === 1 ? leaders[0]!.person : null;
    let outcome: Outcome;
    if (row.named !== null) {
        outcome = row.named === speaker ? "namedCorrect" : "namedWrong";
    } else if (first === speaker) {
        outcome = "firstChoiceCorrect";
    } else if (choices.includes(speaker)) {
        outcome = "offeredOnly";
    } else {
        outcome = choices.length ? "unofferedReview" : "abstained";
    }
    return { outcome, named: row.named, choices, first, tiedFirst: leaders.length > 1 };
}
type Attribution = ReturnType<typeof classification>;
type Population = "owner" | "room" | "remote";
interface ComparedLine extends Key {
    speaker: string;
    population: Population;
    baseline: Attribution;
    candidate: Attribution;
}

function histogram(names: string[]) {
    const totals = new Map<string, number>();
    for (const person of names) {
        totals.set(person, (totals.get(person) ?? 0) + 1);
    }
    return Object.fromEntries(totals);
}

function summarize(lines: ComparedLine[], arm: "baseline" | "candidate") {
    function group(rows: ComparedLine[]) {
        const tally = counts();
        let tiedFirst = 0;
        for (const row of rows) {
            tally[row[arm].outcome]++;
            if (row[arm].tiedFirst) {
                tiedFirst++;
            }
        }
        return { denominator: rows.length, counts: tally, tiedFirst };
    }
    const speakers = new Map<string, ComparedLine[]>();
    for (const line of lines) {
        const bucket = speakers.get(line.speaker) ?? [];
        bucket.push(line);
        speakers.set(line.speaker, bucket);
    }
    return {
        denominator: lines.length,
        populations: {
            owner: group(lines.filter((line) => line.population === "owner")),
            room: group(lines.filter((line) => line.population === "room")),
            remote: group(lines.filter((line) => line.population === "remote")),
        },
        speakers: Object.fromEntries(
            Array.from(
                speakers,
                ([person, rows]) =>
                    [
                        person,
                        {
                            ...group(rows),
                            namedAs: histogram(rows.flatMap((row) => row[arm].named ?? [])),
                            firstAs: histogram(rows.flatMap((row) => row[arm].first ?? [])),
                        },
                    ] as const
            )
        ),
        wrongFirst: histogram(
            lines.flatMap((line) => (line[arm].first && line[arm].first !== line.speaker ? [line[arm].first] : []))
        ),
        falseOffers: histogram(lines.flatMap((line) => line[arm].choices.filter((person) => person !== line.speaker))),
    };
}

function transitions(lines: ComparedLine[]) {
    const ids = (choose: (line: ComparedLine) => boolean) => lines.filter(choose).map((line) => line.id);
    const before = counts();
    const after = counts();
    for (const line of lines) {
        before[line.baseline.outcome]++;
        after[line.candidate.outcome]++;
    }
    return {
        denominator: lines.length,
        ids: lines.map((line) => line.id),
        baseline: before,
        candidate: after,
        correctNameToReview: ids((line) => line.baseline.outcome === "namedCorrect" && line.candidate.named === null),
        correctNameToWrong: ids(
            (line) => line.baseline.outcome === "namedCorrect" && line.candidate.outcome === "namedWrong"
        ),
        newWrongName: ids((line) => line.baseline.outcome !== "namedWrong" && line.candidate.outcome === "namedWrong"),
        recoveredName: ids(
            (line) => line.baseline.outcome !== "namedCorrect" && line.candidate.outcome === "namedCorrect"
        ),
        wrongNameDelta: after.namedWrong - before.namedWrong,
    };
}

/** The CLI and REPL score the same four immutable JSON documents. No meeting store is opened. */
export function measureRoomCall(input: {
    reference: unknown;
    baseline: unknown;
    candidate: unknown;
    holdout: unknown;
}) {
    const manifest = roomCallHoldout.parse(input.holdout);
    const reference = roomCallTranscript.parse(input.reference);
    if (sha256Json(input.reference) !== manifest.referenceHash || reference.meeting !== manifest.source.rootMeeting) {
        throw new Error("Reference or source meeting differs from the frozen reference");
    }
    const baseline = snapshotSchema.parse(input.baseline);
    const candidate = snapshotSchema.parse(input.candidate);
    const holdoutHash = sha256Json(input.holdout);
    for (const [arm, snap] of [
        ["baseline", baseline],
        ["candidate", candidate],
    ] as const) {
        validateRun({ arm, snap, manifest, holdoutHash });
    }
    if (
        baseline.configHash !== candidate.configHash ||
        baseline.inputHash !== candidate.inputHash ||
        !isDeepStrictEqual(baseline.training, candidate.training) ||
        !isDeepStrictEqual(baseline.muteHint, candidate.muteHint)
    ) {
        throw new Error("Paired inputs, training sources, settings or undecided mute reads differ");
    }
    const truth = indexed(reference.entries, "reference");
    const before = exactRows(reference.entries, baseline.rows, "baseline");
    const after = exactRows(reference.entries, candidate.rows, "candidate");
    const held = indexed(manifest.lines, "holdout");
    const original = indexed(manifest.originalRemote, "original remote cohort");
    const people = new Map<string, Population>();
    for (const [pop, names] of [
        ["owner", [manifest.people.owner]],
        ["room", manifest.people.room],
        ["remote", manifest.people.remote],
    ] as const) {
        for (const person of names) {
            if (people.has(person)) {
                throw new Error(`Duplicate population for ${person}`);
            }
            people.set(person, pop);
        }
    }
    if (
        people.get(manifest.roomTarget) !== "room" ||
        people.get(manifest.lateRemote.person) !== "remote" ||
        manifest.lateRemote.toSec <= manifest.lateRemote.fromSec ||
        manifest.mute.firstOmittedSec <= manifest.mute.lastPositiveSec
    ) {
        throw new Error("Invalid target population or cohort boundaries");
    }
    for (const key of original.values()) {
        aligned(held, key);
        if (people.get(plainSpeaker(aligned(truth, key)) ?? "") !== "remote") {
            throw new Error(`Original remote cohort includes non-remote reference: ${key.id}`);
        }
    }
    const unscored: Array<Key & { reference: string }> = [];
    const lines: ComparedLine[] = [];
    for (const key of held.values()) {
        const ref = aligned(truth, key);
        const speaker = plainSpeaker(ref);
        const population = speaker && people.get(speaker);
        if (!speaker || !population) {
            unscored.push({ ...key, reference: ref.speaker });
            continue;
        }
        lines.push({
            ...key,
            speaker,
            population,
            baseline: classification(aligned(before, key), speaker),
            candidate: classification(aligned(after, key), speaker),
        });
    }
    const { lastPositiveSec, firstOmittedSec } = manifest.mute;
    const remoteLines = lines.filter((line) => line.population === "remote");
    const fixedRemote = remoteLines.filter((line) => original.has(line.id));
    const beforeRead = (line: Key) => line.endSec <= lastPositiveSec;
    const betweenReads = (line: Key) => line.endSec > lastPositiveSec && line.startSec < firstOmittedSec;
    const afterRead = (line: Key) => line.startSec >= firstOmittedSec;
    const cohorts = {
        originalRemote: transitions(fixedRemote),
        originalRemoteByMuteRead: {
            before: transitions(fixedRemote.filter(beforeRead)),
            between: transitions(fixedRemote.filter(betweenReads)),
            after: transitions(fixedRemote.filter(afterRead)),
        },
        remote: transitions(remoteLines),
        lateRemote: transitions(
            remoteLines.filter(
                (line) =>
                    line.speaker === manifest.lateRemote.person &&
                    line.startSec >= manifest.lateRemote.fromSec &&
                    line.endSec <= manifest.lateRemote.toSec
            )
        ),
        beforeMuteRead: transitions(lines.filter(beforeRead)),
        betweenMuteReads: transitions(lines.filter(betweenReads)),
        afterMuteRead: transitions(lines.filter(afterRead)),
    };
    const roomLines = lines.filter((line) => line.speaker === manifest.roomTarget);
    const correctNameOrFirst = roomLines.filter(
        (line) => line.candidate.named === line.speaker || line.candidate.first === line.speaker
    ).length;
    const ownerWrongName = lines.filter(
        (line) => line.population === "owner" && line.candidate.named === manifest.roomTarget
    ).length;
    const blanketRoomOffer =
        lines.some((line) => line.speaker !== manifest.roomTarget) &&
        lines.every(
            (line) =>
                line.candidate.choices.includes(manifest.roomTarget) || line.candidate.named === manifest.roomTarget
        );
    const targets = {
        room: {
            person: manifest.roomTarget,
            denominator: roomLines.length,
            correctNameOrFirst,
            goal: 100,
            ownerWrongName,
            ownerWrongNameLimitExclusive: 20,
            met: correctNameOrFirst >= 100 && ownerWrongName < 20,
        },
        remote: {
            met:
                remoteLines.length > 0 &&
                cohorts.remote.correctNameToReview.length === 0 &&
                cohorts.remote.newWrongName.length === 0,
        },
    };
    const { rows: _before, ...baselineInputs } = baseline;
    const { rows: _after, ...candidateInputs } = candidate;
    return {
        structuralAccepted: true,
        qualityPassed: targets.room.met && targets.remote.met && !blanketRoomOffer,
        controls: { blanketRoomOffer },
        targets,
        holdout: manifest,
        holdoutHash,
        inputs: { baseline: baselineInputs, candidate: candidateInputs },
        snapshotHashes: { baseline: sha256Json(input.baseline), candidate: sha256Json(input.candidate) },
        referenceRows: truth.size,
        heldOut: held.size,
        unscored,
        lines,
        cohorts,
        baseline: summarize(lines, "baseline"),
        candidate: summarize(lines, "candidate"),
    };
}

export function measureRoomCallFiles(files: {
    reference: string;
    baseline: string;
    candidate: string;
    holdout: string;
}) {
    const read = (file: string): unknown => SafeJSON.parse(readFileSync(file, "utf8"), { strict: true });
    return measureRoomCall({
        reference: read(files.reference),
        baseline: read(files.baseline),
        candidate: read(files.candidate),
        holdout: read(files.holdout),
    });
}

/** Read an existing frozen bundle beside the requested record. Capture always belongs to the benchmark process. */
export function measureRoomCallMeeting({
    meeting,
    store = new MeetingStore(),
}: {
    meeting: string;
    store?: MeetingStore;
}) {
    const record = store.resolve(meeting);
    if (!record) {
        throw new Error(`Unknown meeting: ${meeting}`);
    }
    const directory = join(store.folder(record.id), "room-call");
    const result = measureRoomCallFiles({
        reference: join(directory, "reference.json"),
        baseline: join(directory, "baseline.json"),
        candidate: join(directory, "candidate.json"),
        holdout: join(directory, "holdout.json"),
    });
    if (result.holdout.source.rootMeeting !== voiceRootMeeting(store, record)) {
        throw new Error("Frozen measurement belongs to another source meeting");
    }
    return result;
}
