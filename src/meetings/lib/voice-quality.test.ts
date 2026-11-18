import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    insertVoiceSample,
    readVoiceLibrary,
    type SampleId,
    sourceForVoicePrint,
    type VoicePrint,
} from "@genesiscz/utils/meetings/voice-library";
import { toolDataDir } from "@genesiscz/utils/storage/root";

let original: string;
beforeEach(() => {
    original = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "quality-")));
});
afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", original));

function add(name: string, meeting: string, embedding: number[], extra: Partial<VoicePrint> = {}): SampleId {
    const print: VoicePrint = {
        meeting,
        embedding,
        sourceSha: meeting,
        seat: "mic",
        track: "source-mic",
        fromSec: 1,
        toSec: 3,
        confirmedAt: "2026-10-01",
        ...extra,
    };
    const result = insertVoiceSample({
        project: "orchard",
        owner: { name },
        model: "fixture",
        print,
        source: sourceForVoicePrint(print),
        origin: "enrol",
        acquiredBy: "manual",
    });
    if (result.status !== "added") {
        throw new Error("Fixture attachment was not added.");
    }
    return result.id;
}
async function quality() {
    const { learntVoices } = await import("./voice-quality");
    const { library, conflicts } = readVoiceLibrary();
    return learntVoices({ model: library.model, samples: library.samples, conflicts }, { outlierBelow: 0.5 });
}

test("P2 quality holds out the planted foreign voice and identifies its independent compatible neighbor without writing", async () => {
    for (const meeting of ["a", "b", "c"]) {
        add("Reed Example", meeting, [3, 0]);
    }
    const foreign = add("Reed Example", "d", [0, 8]);
    const neighbor = add("Vale Example", "e", [0, 1]);
    add("Fenn Example", "f", [0, 1], { track: "mic-raw" });
    add("Fenn Example", "g", [0, 1, 0]);
    const file = toolDataDir("meetings", "voice-library", "library.json");
    const bytes = readFileSync(file);
    const group = (await quality()).find((row) => row.owner.name === "Reed Example")!;
    expect(group.independent).toBe(4);
    expect(group.meanCosine).toBeCloseTo(Math.sqrt(10) / 4);
    expect(group.samples.filter((s) => s.outlier)).toEqual([
        expect.objectContaining({
            id: foreign,
            score: 0,
            neighbor: { id: neighbor, owner: { name: "Vale Example" }, score: 1 },
        }),
    ]);
    expect(readFileSync(file)).toEqual(bytes);
});

test("P2 quality marks overlap, zero centroids and absent compatible neighbors as insufficient evidence", async () => {
    add("Reed Example", "a", [1, 0]);
    add("Reed Example", "a", [1, 0], { fromSec: 2, toSec: 5 });
    add("Reed Example", "b", [-1, 0]);
    add("Reed Example", "c", [0, 0]);
    for (const [i, vector] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
    ].entries()) {
        add("Vale Example", `balanced-${i}`, vector, { track: "mic-raw" });
    }
    const rows = await quality();
    const reed = rows.find((r) => r.owner.name === "Reed Example")!;
    expect(reed.independent).toBe(2);
    expect(reed.samples.every((s) => s.score === null && s.neighbor === null && !s.outlier)).toBe(true);
    expect(rows.find((r) => r.owner.name === "Vale Example")?.samples.every((s) => s.reason === "zero-centroid")).toBe(
        true
    );
});

test("P2 correction receipts refuse occupied and rejected destinations, preserve IDs on Undo and block superseded Undo", async () => {
    const { correctVoiceSample } = await import("@genesiscz/utils/meetings/voice-library");
    const id = add("Reed Example", "source", [1, 0]);
    const move = { kind: "move" as const, id, to: { name: "Vale Example" }, token: "transfer" };
    const transfer = correctVoiceSample(move);
    expect(correctVoiceSample(move)).toEqual(transfer);
    const moved = readVoiceLibrary().library.samples[0]!;
    expect(moved).toMatchObject({ id, owner: move.to, origin: "enrol", acquiredBy: "manual" });
    const before = readFileSync(toolDataDir("meetings", "voice-library", "library.json"));
    expect(() => correctVoiceSample({ kind: "move", id, to: { name: "Reed Example" } })).toThrow("wrong-person");
    expect(readFileSync(toolDataDir("meetings", "voice-library", "library.json"))).toEqual(before);
    const undo = correctVoiceSample({ kind: "revert", correction: transfer.token });
    expect(readVoiceLibrary().library.samples[0]).toEqual(transfer.before[0]!);
    expect(readVoiceLibrary().library.rejected).toEqual([]);
    correctVoiceSample({ kind: "revert", correction: undo.token });
    expect(readVoiceLibrary().library.samples).toEqual([moved]);
    correctVoiceSample({ kind: "reject", id, reason: "bad-audio" });
    expect(() => correctVoiceSample({ kind: "revert", correction: transfer.token })).toThrow("Stale");
    expect(readVoiceLibrary().library.samples).toEqual([]);
});
