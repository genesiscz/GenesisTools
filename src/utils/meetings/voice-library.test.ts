import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { meetingsConfigSchema } from "./config";
import { PeopleBook } from "./people-book";
import type { ConfirmedSampleInput, LibraryV2, VoiceOwner } from "./voice-library";
import { addVoicePrint, readVoiceStore, removeVoicePrint, type VoicePrint, voicePrintSchema } from "./voice-store";

let restoreHome: string;
beforeEach(() => {
    restoreHome = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "voice-library-")));
});
afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", restoreHome));

const model = "fixture-model";
const first = { name: "River Example", email: "river.one@example.test" };
const second = { name: first.name, email: "river.two@example.test" };
const libraryPath = () => toolDataDir("meetings", "voice-library", "library.json");
const persisted = (): LibraryV2 => SafeJSON.parse(readFileSync(libraryPath(), "utf8"), { strict: true });
const library = () => import("./voice-library");

function print(n: number): VoicePrint {
    return {
        meeting: `fixture-meeting-${n % 3}`,
        sourceSha: `digest-${n % 3}`,
        seat: n % 2 ? "call" : "mic",
        track: n % 2 ? "system" : "source-mic",
        fromSec: n,
        toSec: n + 1.25,
        embedding: [-0.125 - n * 0.03125, 0, n + 0.125],
        confirmedAt: "2026-10-10T14:00:00Z",
        ...(n % 2 ? { question: `i${n}` } : {}),
    };
}

function legacy(project: string, samples: VoicePrint[], owner: VoiceOwner = { name: first.name }, voiceModel = model) {
    const dir = toolDataDir("meetings", "voices");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${project}.json`);
    const document = {
        version: 1,
        model: voiceModel,
        people: { [owner.name]: { ...(owner.email ? { email: owner.email } : {}), samples } },
    };
    const bytes = `${SafeJSON.stringify(document, null, 2)}\n`;
    atomicWriteFileSync(file, bytes);
    return { file, bytes };
}

test("listing and planning preserve all source bytes; a write imports every attachment once, including the 87-row store", async () => {
    const prints = Array.from({ length: 87 }, (_, i) => print(i === 86 ? 3 : i));
    const fixtures = [
        { project: "garden", owner: { name: first.name }, prints },
        { project: "library", owner: first, prints: [print(2)] },
        { project: "col-fe.v1", owner: second, prints: [print(4), print(4)] },
    ];
    const sources = fixtures.map((f) => legacy(f.project, f.prints, f.owner));
    sources.push(legacy("aaa-empty", [], first, "unused-model"));
    const inventory = () => readdirSync(toolDataDir("meetings"), { recursive: true }).sort();
    const files = inventory();
    const { readVoiceLibrary, upgradeVoiceLibrary, voicesIn } = await library();
    const view = readVoiceLibrary();
    expect(view.conflicts).toEqual([]);
    const list = voicesIn(view, { kind: "all" }).flatMap((r) => r.samples);
    expect(list).toHaveLength(90);
    expect(list.every((s) => !("embedding" in s) && s.origin === "legacy" && s.acquiredBy === "migration")).toBe(true);
    expect(upgradeVoiceLibrary({ dryRun: true })).toEqual({ revision: 0, imported: 90, changed: true });
    expect(inventory()).toEqual(files);
    for (const f of sources) {
        expect(readFileSync(f.file, "utf8")).toBe(f.bytes);
    }

    addVoicePrint("another", "Avery Example", print(100), model);
    const disk = persisted();
    expect(disk.model).toBe(model);
    expect(disk.samples).toHaveLength(91);
    expect(new Set(disk.samples.map((s) => s.id)).size).toBe(91);
    expect(disk.imports.map((m) => [m.project, m.rows.length])).toEqual([
        ["aaa-empty", 0],
        ["col-fe.v1", 2],
        ["garden", 87],
        ["library", 1],
    ]);
    for (const f of fixtures) {
        const rows = disk.samples.filter((s) => s.project === f.project);
        expect(rows.map((s) => [s.owner, voicePrintSchema.parse(s)])).toEqual(f.prints.map((p) => [f.owner, p]));
        expect(rows.map((s) => s.id)).toEqual(list.filter((s) => s.project === f.project).map((s) => s.id));
        expect(readVoiceStore(f.project)).toEqual({
            version: 1,
            model,
            people: { [first.name]: { samples: f.prints } },
        });
    }
    expect(readVoiceLibrary().library).toEqual(disk);
    const bytes = readFileSync(libraryPath());
    expect(
        upgradeVoiceLibrary({
            publish: () => {
                throw new Error("unexpected second publish");
            },
        })
    ).toEqual({ changed: false, imported: 0, revision: disk.revision });
    expect(readFileSync(libraryPath())).toEqual(bytes);
    for (const f of sources) {
        expect(readFileSync(f.file, "utf8")).toBe(f.bytes);
    }
});

test("colliding IDs compare the whole original tuple and keep distinct identical occurrences across reorder and removal", async () => {
    const a = print(1),
        b = { ...a, embedding: [1, 0] };
    legacy("garden", [b, a, a]);
    const { readVoiceLibrary, upgradeVoiceLibrary } = await library();
    const options = { idDigest: () => "123" };
    const before = readVoiceLibrary(options).library.samples;
    const ids = before.map((s) => s.id);
    expect(ids).toContain("vs_123");
    expect(new Set(ids).size).toBe(3);
    legacy("garden", [a, a, b]);
    expect(readVoiceLibrary(options).library.samples.map((s) => s.id)).toEqual([ids[1], ids[2], ids[0]]);
    upgradeVoiceLibrary(options);
    expect(persisted().imports[0]!.rows.map((r) => r.occurrence)).toEqual([0, 1, 0]);
    const duplicated = readFileSync(libraryPath());
    expect(() => addVoicePrint("garden", first.name, a, model)).toThrow("attachment conflict");
    expect(readFileSync(libraryPath())).toEqual(duplicated);
    expect(removeVoicePrint("garden", first.name)).toBe(3);
    const late = legacy("garden", [b, a, a, a]);
    expect(readVoiceLibrary(options).library.samples).toHaveLength(1);
    expect(upgradeVoiceLibrary(options).imported).toBe(1);
    const disk = persisted();
    expect(disk.samples).toHaveLength(1);
    expect(ids).not.toContain(disk.samples[0]!.id);
    expect(disk.imports[0]!.rows).toHaveLength(4);
    expect(readFileSync(late.file, "utf8")).toBe(late.bytes);
});

test("a busy v1 writer and failures on both sides of publication recover the late print and its ID", async () => {
    const original = legacy("garden", [print(1)]);
    const { readVoiceLibrary, upgradeVoiceLibrary } = await library();
    const originalId = readVoiceLibrary().library.samples[0]!.id;
    const busy = /already being held|ELOCKED/i;
    let late = original;
    withPathArbitrationSync(original.file, () => {
        expect(() => upgradeVoiceLibrary()).toThrow(busy);
        expect(existsSync(libraryPath())).toBe(false);
        late = legacy("garden", [print(1), print(2)]);
    });
    const preview = readVoiceLibrary().library.samples.map((s) => s.id);
    expect(preview[0]).toBe(originalId);
    expect(() =>
        upgradeVoiceLibrary({
            publish: () => {
                expect(() => withPathArbitrationSync(late.file, () => undefined)).toThrow(busy);
                throw new Error("before rename");
            },
        })
    ).toThrow("before rename");
    expect(existsSync(libraryPath())).toBe(false);
    expect(() =>
        upgradeVoiceLibrary({
            publish: (file, bytes) => {
                atomicWriteFileSync(file, bytes);
                throw new Error("after rename");
            },
        })
    ).toThrow("after rename");
    expect(persisted().samples.map((s) => s.id)).toEqual(preview);
    expect(upgradeVoiceLibrary()).toEqual({ changed: false, revision: 1, imported: 0 });
    expect(readFileSync(late.file, "utf8")).toBe(late.bytes);

    const oldLibrary = readFileSync(libraryPath());
    // Force another publication. An older writer creates a new project after inventory but before the rename.
    legacy("garden", [print(1), print(2), print(3)]);
    const newPath = toolDataDir("meetings", "voices", "late-project.json");
    let lateBytes = "";
    expect(
        upgradeVoiceLibrary({
            publish: (file, bytes) => {
                withPathArbitrationSync(newPath, () => {
                    lateBytes = legacy("late-project", [print(4)]).bytes;
                });
                atomicWriteFileSync(file, bytes);
            },
        })
    ).toEqual({ changed: true, revision: 2, imported: 1 });
    expect(readFileSync(libraryPath())).not.toEqual(oldLibrary);
    const published = readFileSync(libraryPath());
    const nextIds = readVoiceLibrary().library.samples.map((s) => s.id);
    expect(nextIds).toHaveLength(4);
    expect(readFileSync(libraryPath())).toEqual(published);
    expect(upgradeVoiceLibrary()).toEqual({ changed: true, revision: 3, imported: 1 });
    expect(persisted().samples.map((s) => s.id)).toEqual(nextIds);
    expect(nextIds.slice(0, 2)).toEqual(preview);
    expect(readFileSync(newPath, "utf8")).toBe(lateBytes);
});

test("model and validation conflicts identify the source, allow scoped recovery and prevent partial first or later writes", async () => {
    const one = legacy("garden", [print(1)]);
    const other = legacy("studio", [print(2)], second, "incompatible");
    const { readVoiceLibrary, predictionPrints, upgradeVoiceLibrary } = await library();
    expect(readVoiceLibrary().conflicts).toMatchObject([{ project: "studio", file: other.file }]);
    expect(() => upgradeVoiceLibrary()).toThrow(other.file);
    expect(() => addVoicePrint("third", first.name, print(3), model)).toThrow("incompatible");
    expect(existsSync(libraryPath())).toBe(false);
    expect(predictionPrints({ project: "garden", scope: "all" }).samples.map((s) => s.project)).toEqual(["garden"]);
    expect(readVoiceStore("studio")).toEqual({
        version: 1,
        model: "incompatible",
        people: { [first.name]: { samples: [print(2)] } },
    });
    for (const fixture of [one, other]) {
        expect(readFileSync(fixture.file, "utf8")).toBe(fixture.bytes);
    }
    legacy("studio", [print(2)], second);
    upgradeVoiceLibrary();
    const snapshot = readFileSync(libraryPath());
    const bad = legacy("invalid", [print(5)]);
    writeFileSync(bad.file, '{"version":1,"model":"fixture-model","people":{"unknown":{"samples":[{}]}}}');
    expect(() => upgradeVoiceLibrary()).toThrow(bad.file);
    expect(readVoiceStore("garden").people[first.name]!.samples).toEqual([print(1)]);
    expect(readFileSync(libraryPath())).toEqual(snapshot);
});

test("a directory merge and its undo preserve raw homonyms, unresolved ownership, sources and binding refusals", async () => {
    legacy("one", [print(1)], first);
    legacy("two", [print(2)], second);
    legacy("unknown", [print(3)]);
    const { readVoiceLibrary, voicesIn, upgradeVoiceLibrary, sourceForVoicePrint } = await library();
    upgradeVoiceLibrary();
    const disk = persisted();
    disk.rejected.push({
        source: sourceForVoicePrint(print(2)),
        owner: first,
        reason: "wrong-person",
        at: print(1).confirmedAt,
        token: "wrong-binding",
    });
    atomicWriteFileSync(libraryPath(), SafeJSON.stringify(disk));
    const bytes = readFileSync(libraryPath());
    const rows = () => voicesIn(readVoiceLibrary(), { kind: "all" });
    const original = rows();
    expect(original.map((r) => r.owner)).toEqual([first, second, { name: first.name }]);

    const book = new PeopleBook();
    const merge = await book.merge({ people: [first, second], name: "River Joined" });
    expect(rows().map((r) => [r.owner.name, r.samples.map((s) => s.owner)])).toEqual([
        ["River Joined", [first, second]],
        [first.name, [{ name: first.name }]],
    ]);
    expect(voicesIn(readVoiceLibrary(), { kind: "project", project: "two" }, first)[0]?.projects).toEqual(["two"]);
    expect(readVoiceStore("one").people[first.name]!.samples).toEqual([print(1)]);
    await new PeopleBook().unmerge(merge.token);
    expect(rows()).toEqual(original);
    expect(readVoiceLibrary().library).toEqual(disk);
    expect(readFileSync(libraryPath())).toEqual(bytes);
});

test("checked insertion reuses its persisted receipt and prediction holds out only related speech", async () => {
    const { insertVoiceSample, predictionPrints, sourceForVoicePrint, voicesIn, readVoiceLibrary } = await library();
    const p = print(2),
        source = sourceForVoicePrint(p);
    const input: ConfirmedSampleInput = {
        project: "one",
        owner: first,
        print: p,
        model,
        source,
        origin: "answer",
        acquiredBy: "live",
        decision: { token: "decision-one", item: "i2" },
    };
    const inserted = insertVoiceSample(input);
    expect(inserted.status).toBe("added");
    const saved = readFileSync(libraryPath());
    expect(insertVoiceSample(input)).toEqual({ ...inserted, status: "already-present" });
    expect(insertVoiceSample({ ...input, owner: second, decision: undefined }).status).toBe("conflict");
    expect(insertVoiceSample({ ...input, print: { ...p, embedding: [4, 8] } }).status).toBe("conflict");
    expect(readFileSync(libraryPath())).toEqual(saved);
    const other = (print: VoicePrint, related: Partial<typeof source> = {}) =>
        insertVoiceSample({
            ...input,
            decision: undefined,
            project: "two",
            print,
            source: { ...sourceForVoicePrint(print), ...related },
        });
    other({ ...p, meeting: "retimed-copy", fromSec: 19, toSec: 20 }, source);
    other({ ...p, meeting: "other-recording" });
    const cross = { ...p, fromSec: 3, toSec: 4 };
    other(cross);
    expect(predictionPrints({ project: "one", scope: "project" }).samples).toHaveLength(1);
    expect(
        predictionPrints({
            project: "one",
            scope: "all",
            target: { ...source, fromSec: p.fromSec, toSec: p.toSec },
        }).samples.map((s) => s.meeting)
    ).toEqual(["other-recording"]);
    expect(predictionPrints({ project: "one", scope: "all", owners: [second] }).samples).toEqual([]);
    expect(voicesIn(readVoiceLibrary(), { kind: "meeting", meeting: p.meeting })[0]!.samples).toHaveLength(2);
    const reopened = persisted();
    expect(reopened.samples).toHaveLength(4);
    expect(reopened.receipts).toHaveLength(1);
    reopened.rejected.push({ source, owner: first, reason: "wrong-person", token: "wrong", at: p.confirmedAt });
    atomicWriteFileSync(libraryPath(), SafeJSON.stringify(reopened));
    const rejected = readFileSync(libraryPath());
    expect(insertVoiceSample(input)).toMatchObject({ status: "refused", reason: "wrong-person" });
    expect(readFileSync(libraryPath())).toEqual(rejected);
});

test("the default predictor can use all projects and the outlier threshold is a configurable cosine", () => {
    const settings = (voice: object) =>
        meetingsConfigSchema.parse({ global: { speakerLabels: { voice } } }).global.speakerLabels.voice;
    expect(settings({})).toMatchObject({ sampleScope: "all", outlierBelow: 0.5 });
    expect(settings({ sampleScope: "project", outlierBelow: -0.3 })).toMatchObject({
        sampleScope: "project",
        outlierBelow: -0.3,
    });
    expect(() => settings({ sampleScope: "meeting" })).toThrow();
    expect(() => settings({ outlierBelow: 1.01 })).toThrow();
});
