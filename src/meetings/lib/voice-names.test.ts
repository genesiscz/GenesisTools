import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import * as hostStats from "@genesiscz/utils/macos/host-stats";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import * as voice from "@genesiscz/utils/meetings/voice";
import * as voiceLibraryModule from "@genesiscz/utils/meetings/voice-library";
import { insertVoiceSample, readVoiceLibrary, sourceForVoicePrint } from "@genesiscz/utils/meetings/voice-library";
import { addVoicePrint, readVoiceStore, type VoicePrint, type VoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { Storage } from "@genesiscz/utils/storage";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { journalEntrySchema } from "./decision-actions";
import { DecisionJournal } from "./decision-journal";
import { identifiedDepartures } from "./departure";
import { duplicateMeeting } from "./duplicate";
import { itemWhat } from "./item-text";
import { OpenedMeeting } from "./opened-meeting";
import { voicesPreview } from "./service/api";
import * as soundModule from "./sound";
import { meetingSound } from "./sound";
import { mergeLineLabels, preparePreviewLabels, proposeSpeakerLabels, speakerLabelRule } from "./speaker-labels";
import type { LabelContext } from "./speaker-labels/types";
import { embedSeatLines, voiceLabeler } from "./speaker-labels/voice";
import { suggestItems } from "./suggest";
import { correctionsOf } from "./transcript-corrections";
import { nameByVoice, type VoiceLine } from "./voice-names";
import { saveAnsweredVoiceSamples, undoAnsweredVoiceSamples } from "./voice-samples";
import * as voices from "./voices";

let previousHome: string;
beforeEach(() => {
    previousHome = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "voice-names-")));
});
afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", previousHome));

const settings = meetingsConfigSchema.parse({}).global.speakerLabels.voice;
const alice = { person: "Alice Example", seat: "mic" as const, fromSec: 0, toSec: 100 };
const bob = { person: "Bob Example", seat: "mic" as const, fromSec: 0, toSec: 100 };
const basePrint: VoicePrint = {
    meeting: "training",
    sourceSha: "digest",
    seat: "mic",
    track: "source-mic",
    fromSec: 0,
    toSec: 5,
    embedding: [1, 0],
    confirmedAt: "2026-11-01T10:00:00Z",
};
function storeOf(people: Record<string, number[][]>): VoiceStore {
    return {
        version: 1,
        model: "fixture-model",
        people: Object.fromEntries(
            Object.entries(people).map(([person, vectors]) => [
                person,
                { samples: vectors.map((embedding) => ({ ...basePrint, embedding })) },
            ])
        ),
    };
}
function line(embedding: number[], fields: Partial<VoiceLine> = {}): VoiceLine {
    return {
        index: 0,
        seat: "mic",
        track: "source-mic",
        channels: [
            {
                quality: "ready",
                model: "fixture-model",
                embedding,
                fromSec: 5,
                toSec: 8,
                channel: 0,
                track: "raw-mic",
                source: { audioPath: "fixture.wav", size: 1, mtimeMs: 1 },
            },
        ],
        ...fields,
    };
}
function name(
    options: {
        lines?: VoiceLine[];
        store?: VoiceStore;
        attended?: LabelContext["attended"];
        gate?: typeof settings.gate;
        minSeconds?: number;
        applyAbove?: number;
    } = {}
) {
    return nameByVoice({
        ...settings,
        lines: [line([1, 0])],
        store: storeOf({ [alice.person]: [[1, 0]], [bob.person]: [[0, 1]] }),
        attended: [alice, bob],
        ...options,
    });
}

function timedLine(index: number, fromSec: number, vector: number[], seat: VoiceLine["seat"]): VoiceLine {
    const toSec = fromSec + 3;
    return line(vector, {
        index,
        fromSec,
        toSec,
        seat,
        track: seat === "mic" ? "source-mic" : "source-call",
        channels: line(vector).channels.map((channel) => ({ ...channel, fromSec, toSec })),
    });
}

test("exclusion names a late remote only inside her stay and preserves direct matches", () => {
    const seat = "call";
    const enrolled = { ...alice, seat } as const;
    const late = { ...bob, seat, fromSec: 20, toSec: 50 } as const;
    const store = storeOf({ [alice.person]: [[1, 0]] });
    store.people[alice.person]!.samples[0] = { ...basePrint, seat, track: "source-call" };
    const lines = [10, 18, 20, 24, 28, 32, 49, 55].map((at, i) => timedLine(i, at, at === 24 ? [1, 0] : [0, 1], seat));
    const labels = name({ lines, attended: [enrolled, late], store });
    expect(labels.map((row) => row.person)).toEqual([
        undefined,
        undefined,
        bob.person,
        alice.person,
        bob.person,
        bob.person,
        undefined,
        undefined,
    ]);
    expect(labels[2]).toMatchObject({
        reason: "exclusion",
        margin: settings.gate.score,
        next: { person: alice.person, score: 0 },
    });
    expect(labels[2]!.score!).toBeLessThanOrEqual(settings.exclusion.maxConfidence);
    expect(labels[3]?.reason).toBe("named");
});

test("exclusion on a shared microphone needs one unsampled person and one coherent stay", () => {
    const lines = [5, 10, 15, 30, 35, 40].map((at, i) => timedLine(i, at, i === 4 ? [0, -1] : [0, 1], "mic"));
    const options = {
        lines,
        store: storeOf({ [alice.person]: [[1, 0]] }),
        attended: [alice, { ...bob, toSec: 20 }, { ...bob, fromSec: 25 }],
    };
    const labels = name(options);
    expect(labels.slice(0, 3).map((row) => row.person)).toEqual(Array(3).fill(bob.person));
    expect(labels.slice(3).map((row) => [row.person, row.reason])).toEqual(
        Array(3).fill([undefined, "exclusion-not-one-voice"])
    );
    const nobody = (rows: ReturnType<typeof name>) => rows.every((row) => row.person === undefined);
    expect(nobody(name({ ...options, lines: lines.slice(0, 1) }))).toBe(true);
    const twoVisitors = name({ ...options, attended: [alice, bob, { ...bob, person: "Gale Example" }] });
    expect(nobody(twoVisitors)).toBe(true);
    expect(twoVisitors.every((row) => row.next === undefined)).toBe(true);
    expect(
        name({ ...options, applyAbove: 0 })
            .slice(0, 3)
            .map((row) => row.reason)
    ).toEqual(Array(3).fill("exclusion"));
    expect(nobody(nameByVoice({ ...settings, ...options, exclusion: { ...settings.exclusion, enabled: false } }))).toBe(
        true
    );
    expect(nobody(nameByVoice({ ...settings, ...options, exclusion: { ...settings.exclusion, margin: 0.5 } }))).toBe(
        true
    );
    expect(nobody(name({ ...options, store: storeOf({}) }))).toBe(true);
    const varied = storeOf({
        [alice.person]: [
            [0, 1],
            [1, -1],
            [1, -1],
            [1, -1],
        ],
    });
    expect(nobody(name({ ...options, lines: lines.slice(0, 3), store: varied }))).toBe(true);
    expect(nameByVoice({ ...settings, ...options, applyAbove: 0.3 })[0]!.score!).toBeLessThan(0.3);
});

test("meeting enrolment holds out overlapping windows from both stores and keeps its prints local", () => {
    const lines = [5, 6, 12, 18, 24, 30].map((at, i) => timedLine(i, at, i < 3 ? [1, 0] : [0, 1], "mic"));
    const store = storeOf({});
    store.model = "";
    const options = {
        ...settings,
        lines,
        store,
        attended: [alice, bob],
        meeting: "current",
        certain: new Map([[0, alice.person]]),
    };
    const labels = nameByVoice(options);
    expect(labels.map((row) => row.person)).toEqual([
        undefined,
        undefined,
        alice.person,
        bob.person,
        bob.person,
        bob.person,
    ]);
    expect(store.people).toEqual({});
    const saved = storeOf({ [alice.person]: [[1, 0]] });
    saved.people[alice.person]!.samples[0] = { ...basePrint, meeting: "current", fromSec: 5, toSec: 8 };
    expect(nameByVoice({ ...options, store: saved }).map((row) => row.person)).toEqual(labels.map((row) => row.person));
});

test("P2 all-project prediction holds out a retimed duplicate, filters refused temporary seeds and preserves C3 compatibility", async () => {
    const { opened, record, store } = await sampledMeeting("spring");
    const copy = await duplicateMeeting({ store, ref: record.id, withoutItems: true });
    const second = await duplicateMeeting({ store, ref: copy.id, withoutItems: true });
    const duplicate = store.read(second.id)!;
    expect(duplicate.voiceRootMeeting).toBe(record.id);
    expect(duplicate.items).toEqual([]);
    const source = await opened.meeting();
    const transcript = source.transcript.map((entry, i) => ({ ...entry, id: `line-${i}` }));
    const { voiceLineKeys, correctVoiceSample } = await import("@genesiscz/utils/meetings/voice-library");
    const keys = voiceLineKeys({ ...source, transcript });
    const printed = { ...basePrint, meeting: record.id };
    const identity = sourceForVoicePrint(printed, record.id, keys[0]);
    const learned = insertVoiceSample({
        project: "winter",
        owner: { name: alice.person },
        source: identity,
        origin: "enrol",
        acquiredBy: "manual",
        print: printed,
        model: "fixture-model",
    });
    if (learned.status !== "added") {
        throw new Error("The source fixture needs a persisted sample.");
    }
    const target = OpenedMeeting.of(store, duplicate);
    spies.push(
        spyOn(target, "meeting").mockResolvedValue({
            ...source,
            transcript: transcript.map((entry) => ({ ...entry, startSec: entry.startSec! + 20 })),
        })
    );
    const lines = [20, 25, 30].map((at, i) => timedLine(i, at, [1, 0], "mic"));
    const run = (scope: "project" | "all", certain?: Map<number, string>) =>
        voiceLabeler({
            opened: target,
            settings: { ...settings, sampleScope: scope },
            readLines: async () => lines,
        }).propose({
            project: record.project,
            attended: [alice],
            lines: lines.map((l, i) => ({ index: i, fromSec: l.fromSec!, toSec: l.toSec!, seat: l.seat })),
            certain,
        });
    expect(await run("project")).toEqual([]);
    const predicted = await run("all");
    expect(predicted[0]?.person).toBeUndefined();
    expect(predicted[1]?.person).toBe(alice.person);
    correctVoiceSample({ kind: "reject", id: learned.id, reason: "wrong-person" });
    for (const line of lines) {
        const channel = line.channels[0]!;
        if (channel.quality === "ready") {
            channel.source.audioPath = join(store.folder(record.id), "fixture.wav");
        }
    }
    expect((await run("all", new Map([[0, alice.person]]))).every((row) => !row.person)).toBe(true);
    expect(readVoiceLibrary().library.samples).toEqual([]);

    const saved = storeOf({ [alice.person]: [[1, 0]], [bob.person]: [[0, 1]] });
    saved.people[bob.person]!.samples[0]!.track = "mic-raw";
    const abstain = nameByVoice({
        ...settings,
        store: saved,
        attended: [alice, bob],
        lines: [1, 6, 12].map((at, i) => timedLine(i, at, [0, 1], "mic")),
    });
    expect(abstain.every((row) => row.reason !== "exclusion" && !row.person)).toBe(true);
});

test("P2 playback resolves the pinned source and channel by ID and refuses changed media or conflicting selectors", async () => {
    const { opened, record, store } = await sampledMeeting("playback");
    const file = join(store.folder(record.id), "fixture.wav");
    const { sha256FileAsync } = await import("@genesiscz/utils/fs/hash");
    const print = { ...basePrint, meeting: record.id, sourceSha: await sha256FileAsync(file) };
    const receipt = insertVoiceSample({
        project: "playback",
        owner: { name: alice.person },
        model: "fixture-model",
        print,
        source: sourceForVoicePrint(print),
        origin: "enrol",
        acquiredBy: "manual",
    });
    if (receipt.status !== "added") {
        throw new Error("Fixture clip missing.");
    }
    spies.push(spyOn(OpenedMeeting, "of").mockReturnValue(opened));
    const selected = { store, id: receipt.id };
    expect(await voices.voiceSample(selected)).toMatchObject({
        path: file,
        meeting: record.id,
        channel: 0,
        fileFromSec: 0,
        fileToSec: 5,
    });
    await expect(voices.voiceSample({ ...selected, project: "elsewhere" })).rejects.toThrow("Stale");
    await expect(voices.voiceSample({ ...selected, sample: 1 })).rejects.toThrow("Choose");
    writeFileSync(file, "replaced recording");
    await expect(voices.voiceSample(selected)).rejects.toThrow("changed");
});

test("voice registry maps to the canonical rule", () => {
    expect(speakerLabelRule("voice")).toBe(MeetingRule.VoiceEmbedding);
});
test("seat and attendance bounds exclude remote people and late joiners", () => {
    expect(
        name({
            attended: [
                { ...alice, fromSec: 10 },
                { ...bob, seat: "call" },
            ],
        })[0]?.person
    ).toBeUndefined();
    expect(name({ attended: [{ ...alice, toSec: 7 }, bob] })[0]?.person).toBeUndefined();
    expect(name()[0]?.person).toBe(alice.person);
});
test("mean prototypes beat an outlier single print and never mix tracks or seats", () => {
    const store = storeOf({
        [alice.person]: [
            [1, 0],
            [-1, 0],
            [-1, 0],
        ],
        [bob.person]: [[0.8, 0.6]],
    });
    expect(name({ store })[0]?.person).toBe(bob.person);
    store.people[alice.person]!.samples = [
        { ...basePrint, track: "mic-raw" },
        { ...basePrint, seat: "call", track: "source-call" },
    ];
    expect(name({ store })[0]?.person).toBe(bob.person);
});
test("short, empty, zero, incompatible and unavailable voice stays unnamed", () => {
    for (const input of [line([1, 0], { toSec: 5.5 }), line([], {}), line([0, 0]), line([1, 0], { channels: [] })]) {
        expect(name({ lines: [{ ...input, fromSec: 5 }] })[0]?.reason).toBe("no-voice");
    }
    expect(name({ store: { ...storeOf({}), model: "another-model" } })[0]?.reason).toBe("no-voice");
});
test("unsampled attended people raise the configured gate, and identify who lacks a print", () => {
    const attended = [alice, bob, { ...bob, person: "Carol Example" }];
    const input = line([0.5, 0, Math.sqrt(0.75)]);
    const store = storeOf({ [alice.person]: [[1, 0, 0]], [bob.person]: [[0, 1, 0]] });
    const refused = name({ lines: [input], attended, store })[0];
    expect(refused?.reason).toBe("unsampled-present");
    expect(refused?.next?.person).toBe("Carol Example");
    expect(name({ lines: [input], attended, store, gate: { ...settings.gate, unsampledScore: 0.49 } })[0]?.person).toBe(
        alice.person
    );
});
test("one prototype needs loneScore; two prototypes need score and margin", () => {
    expect(
        name({ store: storeOf({ [alice.person]: [[1, 0]] }), attended: [alice], lines: [line([0.6, 0.8])] })[0]?.reason
    ).toBe("no-rival-sample");
    expect(name({ store: storeOf({ [alice.person]: [[1, 0]] }), attended: [alice] })[0]?.person).toBe(alice.person);
    expect(name({ lines: [line([0.72, 0.69])] })[0]?.reason).toBe("below-gate");
});
test("a stranger on a seat of one vetoes its owner, and never supplies a different name", async () => {
    const [veto] = name({ attended: [alice], lines: [line([0, 1])] });
    expect(veto?.reason).toBe("not-the-seat-person");
    const merged = mergeLineLabels(
        new Map([
            ["seat", [{ labeler: "seat", index: 0, seat: "mic", person: alice.person, reason: "seat-of-one" }]],
            ["voice", [veto!]],
        ])
    );
    expect(merged[0]?.person).toBeUndefined();
    expect(merged[0]?.next?.person).toBe(alice.person);

    const { opened, record } = await sampledMeeting("project-veto-fixture");
    addVoicePrint(record.project!, alice.person, { ...basePrint, embedding: [0, 1] }, "fixture-model");
    const config = meetingsConfigSchema.parse({});
    const rows = await proposeSpeakerLabels(opened, config.global.speakerLabels);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => !row.person && row.reason === "not-the-seat-person")).toBe(true);
});
test("sound selection uses a measured recorder clock or falls back to the seat's source channel", async () => {
    const sound = meetingSound({
        folder: "/fixture",
        timelineZeroMs: 0,
        tracks: "best",
        rows: [{ file: "piece", source: "mic", at: "1970-01-01T00:00:00Z", durationMs: 30000, mutedSpans: [] }],
        source: { path: "/fixture/source", source: "wisprflow", layout: "right-mic", durationSec: 60 },
    });
    const mock = spyOn(voice, "embedVoiceLines").mockImplementation(async (options) =>
        options.spans.map((span) => ({ ...line([1, 0]), index: span.index }))
    );
    try {
        const embeddings = await embedSeatLines({ sound, lines: [{ index: 1, seat: "mic", fromSec: 5, toSec: 8 }] });
        expect(mock.mock.calls[0]?.[0].channels[0]?.channel).toBe(1);
        expect(embeddings[0]?.track).toBe("source-mic");
    } finally {
        mock.mockRestore();
    }
});
test("seat groups share one worker setting and report one total across mic, call and missing audio", async () => {
    const sound = meetingSound({
        folder: "/fixture",
        timelineZeroMs: 0,
        tracks: "best",
        rows: [],
        source: { path: "/fixture/source", source: "wisprflow", layout: "right-mic", durationSec: 60 },
    });
    const config = meetingsConfigSchema.parse({ global: { speakerLabels: { voice: { compute: { workers: 3 } } } } });
    const embedded = spyOn(voice, "embedVoiceLines").mockImplementation(async (input) => {
        input.onProgress?.(0, input.spans.length);
        input.onProgress?.(input.spans.length, input.spans.length);
        return input.spans.map((span) => ({ ...line([1, 0]), index: span.index }));
    });
    try {
        const updates: number[][] = [];
        const results = await embedSeatLines({
            config,
            sound,
            lines: [
                { index: 0, seat: "mic", fromSec: 5, toSec: 8 },
                { index: 1, seat: "call", fromSec: 10, toSec: 13 },
                { index: 2, seat: "mic", fromSec: 90, toSec: 93 },
            ],
            onProgress: (done, total) => updates.push([done, total]),
        });
        expect(embedded.mock.calls.map(([input]) => [input.workers, input.clearBackground])).toEqual([
            [3, true],
            [3, true],
        ]);
        expect(updates).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ]);
        expect(results.map(({ index }) => index)).toEqual([0, 1, 2]);
    } finally {
        embedded.mockRestore();
    }
});

test("speaker rows mark model proposals with their cosine score", () => {
    expect(
        itemWhat({
            id: "i1",
            kind: "speaker-range",
            label: "Speaker 1",
            fromSec: 0,
            toSec: 0,
            speaker: alice.person,
            status: "suggested",
            suggestedAt: "2026-11-01T10:00:00Z",
            confidence: 0.71,
            rules: [MeetingRule.VoiceEmbedding],
            evidence: { score: 0.71 },
        })
    ).toEndWith("by voice 0.71");
});

test("a matched voice resolves a goodbye after attendance, indicator and sole-remote evidence", () => {
    const lines = lineEvidence([{ speaker: "Speaker 1", startSec: 0, text: "Goodbye." }], {
        segments: [{ startSec: 0, endSec: 5, channel: "system" }],
        speaking: [],
    });
    const inputs = {
        hints: [
            {
                kind: "leave-then-continues" as const,
                label: "Speaker 1",
                strength: "normal" as const,
                leaves: [{ atSec: 0, continuesAtSec: 40, text: "Goodbye." }],
            },
        ],
        lines,
        selfName: alice.person,
        presence: [bob, { ...bob, person: "Carol Example" }].map((stay) => ({
            name: stay.person,
            fromSec: 0,
            toSec: 100,
            leftAtExact: false,
        })),
        labels: [
            {
                labeler: "voice" as const,
                index: 0,
                seat: "call" as const,
                person: bob.person,
                score: 0.8,
                reason: "named" as const,
            },
        ],
    };
    expect(identifiedDepartures(inputs)).toEqual([{ name: bob.person, atSec: 0, reason: "voice" }]);
    expect(
        identifiedDepartures({ ...inputs, lines: [{ ...lines[0]!, speaking: { "Carol Example": 1 } }] })[0]?.reason
    ).toBe("indicator");
});

test("a goodbye takes its voice from the call seat, never from a mic-seat match on the same line", () => {
    const lines = lineEvidence([{ speaker: "Speaker 1", startSec: 0, text: "Goodbye." }], {
        segments: [{ startSec: 0, endSec: 5, channel: "system" }],
        speaking: [],
    });
    const named = (seat: "mic" | "call", person: string) => ({
        labeler: "voice" as const,
        index: 0,
        seat,
        person,
        score: 0.8,
        reason: "named" as const,
    });
    const departures = identifiedDepartures({
        hints: [
            {
                kind: "leave-then-continues" as const,
                label: "Speaker 1",
                strength: "normal" as const,
                leaves: [{ atSec: 0, continuesAtSec: 40, text: "Goodbye." }],
            },
        ],
        lines,
        selfName: alice.person,
        presence: [bob.person, "Carol Example"].map((name) => ({ name, fromSec: 0, toSec: 100, leftAtExact: false })),
        labels: [named("mic", "Carol Example"), named("call", bob.person)],
    });
    expect(departures).toEqual([{ name: bob.person, atSec: 0, reason: "voice" }]);
});

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
    for (const mock of spies.splice(0).reverse()) {
        mock.mockRestore();
    }
});

test("auto samples CPU once for seat groups with misses and never for a fully cached voice pass", async () => {
    const folder = mkdtempSync(join(tmpdir(), "seat-voice-cache-"));
    const audioPath = join(folder, "source.wav");
    writeFileSync(audioPath, "fixture audio");
    const sound = meetingSound({
        folder,
        rows: [],
        timelineZeroMs: 0,
        tracks: "best",
        source: { path: audioPath, source: "wisprflow", layout: "left-mic", durationSec: 60 },
    });
    const lines: LabelContext["lines"] = [
        { index: 0, seat: "mic", fromSec: 0, toSec: 3 },
        { index: 1, seat: "call", fromSec: 4, toSec: 7 },
    ];
    const pass = { lines, sound, config: meetingsConfigSchema.parse({}), cachePath: join(folder, "voice-lines.json") };
    const sample = spyOn(hostStats, "measureCpuBusyPercent").mockResolvedValue(100);
    const backend = spyOn(voice, "localVoiceBackend").mockReturnValue({
        model: "fixture-model",
        embed: () => ({ embedding: [1, 0] }),
    });
    const spawn = Bun.spawn.bind(Bun);
    const reply = `await Bun.stdin.text(); process.stdout.write('[[{"quality":"ready","model":"fixture-model","embedding":[1,0]}]]');`;
    const workers = spyOn(Bun, "spawn").mockImplementation(() =>
        spawn([process.execPath, "-e", reply], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    );
    spies.push(sample, backend, workers);

    const cold = await embedSeatLines(pass);
    expect(cold.map((line) => line.channels[0]?.quality)).toEqual(["ready", "ready"]);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(workers).toHaveBeenCalledTimes(2);

    sample.mockClear();
    workers.mockClear();
    expect(await embedSeatLines(pass)).toEqual(cold);
    expect(sample).toHaveBeenCalledTimes(0);
    expect(workers).toHaveBeenCalledTimes(0);

    const mixed = await embedSeatLines({ ...pass, lines: [lines[0]!, { ...lines[1]!, toSec: 8 }] });
    expect(mixed[0]).toEqual(cold[0]);
    expect(mixed[1]?.channels[0]?.quality).toBe("ready");
    expect(sample).toHaveBeenCalledTimes(1);
    expect(workers).toHaveBeenCalledTimes(1);
});

test("the voice labeler measures and saves recorder clocks before taking recorder samples", async () => {
    const store = new MeetingStore(new Storage("voice-clock-fixture"));
    const record = await store.create(
        { title: "Planning", start: "2026-11-01T10:00:00Z", createdBy: "new", project: "clock-voice-fixture" },
        { command: "new", change: "fixture" }
    );
    const opened = OpenedMeeting.of(store, record);
    addVoicePrint(record.project!, alice.person, basePrint, "fixture-model");
    const inputs: soundModule.SoundInputs = {
        folder: "/fixture",
        timelineZeroMs: 0,
        tracks: "best",
        rows: [{ file: "piece", source: "mic", at: "1970-01-01T00:00:00Z", durationMs: 30000, mutedSpans: [] }],
        source: { path: "/fixture/source", source: "wisprflow", layout: "left-mic", durationSec: 60 },
    };
    const clock: soundModule.SoundClock = { version: 1, sources: { mic: { correctionSec: 1, pieces: 1, clear: 1 } } };
    const measured = spyOn(soundModule, "measureSoundClock").mockResolvedValue({ clock, pieces: [] });
    const saved = spyOn(soundModule, "saveSoundClock").mockImplementation(() => undefined);
    const embedded = spyOn(voice, "embedVoiceLines").mockImplementation(async (options) =>
        options.spans.map((span) => ({ ...line([1, 0]), index: span.index }))
    );
    spies.push(measured, saved, embedded, spyOn(soundModule, "readSoundInputs").mockResolvedValue(inputs));
    const labeler = voiceLabeler({ opened, settings });
    await labeler.propose({
        lines: [{ index: 0, fromSec: 5, toSec: 8, seat: "mic" }],
        attended: [alice],
        project: record.project,
        sound: meetingSound(inputs),
    });
    expect(measured).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith("/fixture", clock);
    expect(embedded.mock.calls[0]?.[0].audioPath).toBe("/fixture/piece");
    expect(embedded.mock.calls[0]?.[0].spans[0]?.fromSec).toBe(4);
});
/** A meeting of the project `project` whose three lines (0, 5, 10 s) sit on the microphone, embedded as [1, 0]. */
async function sampledMeeting(project: string) {
    const store = new MeetingStore(new Storage(`voice-${project}`));
    const record = await store.create(
        {
            title: "Planning",
            start: "2026-11-01T10:00:00Z",
            createdBy: "new",
            project,
            seats: { room: [alice.person], remote: [] },
        },
        { command: "new", change: "fixture" }
    );
    const opened = OpenedMeeting.of(store, record);
    const audio = `${store.folder(record.id)}/fixture.wav`;
    writeFileSync(audio, "fixture audio");
    const embed = spyOn(voice, "embedVoiceLines").mockImplementation(async (options) =>
        options.spans.map((span) => ({
            index: span.index,
            channels: [
                {
                    ...line([1, 0]).channels[0]!,
                    quality: "ready",
                    model: "fixture-model",
                    embedding: [1, 0],
                    source: { audioPath: audio, size: 13, mtimeMs: 1 },
                    fromSec: span.fromSec,
                    toSec: span.toSec,
                },
            ],
        }))
    );
    spies.push(
        embed,
        spyOn(opened, "presence").mockResolvedValue([{ name: alice.person, fromSec: 0, toSec: 30 }]),
        spyOn(opened, "energy").mockResolvedValue({}),
        spyOn(opened, "evidence").mockResolvedValue({
            segments: [{ startSec: 0, endSec: 20, channel: "mic" }],
            speaking: [],
            files: [],
        }),
        spyOn(opened, "meeting").mockResolvedValue({
            sourceMeetingId: "planning",
            title: "Planning",
            start: record.start!,
            participants: [],
            speakers: [],
            folders: [],
            transcript: [
                { speaker: "Speaker 1", startSec: 0, text: "First." },
                { speaker: "Speaker 1", startSec: 5, text: "Second." },
                { speaker: "Speaker 1", startSec: 10, text: "Third." },
            ],
        }),
        spyOn(opened, "sound").mockResolvedValue({
            tracks: [],
            slice: (request) => ({
                track: "source-mic",
                path: audio,
                channel: 0,
                clock: "source",
                fileFromSec: request.fromSec,
                fileToSec: request.toSec,
            }),
        })
    );
    return { store, record, opened, embed };
}

test("voice preview uses this meeting's independent seats, indicators and human decisions without saving samples", async () => {
    const { record, opened } = await sampledMeeting("local-preview-fixture");
    record.seats = { room: [alice.person, bob.person], remote: [] };
    const meeting = await opened.meeting();
    meeting.transcript = [0, 5, 10, 15, 20, 25, 30].map((startSec) => ({
        speaker: "Speaker 1",
        startSec,
        text: "Hello.",
    }));
    const config = meetingsConfigSchema.parse({});
    spies.push(
        spyOn(opened, "presence").mockResolvedValue([
            { name: alice.person, fromSec: 0, toSec: 35 },
            { name: bob.person, fromSec: 5, toSec: 35 },
        ]),
        spyOn(opened, "evidence").mockResolvedValue({
            segments: [{ startSec: 0, endSec: 35, channel: "mic" }],
            files: [],
            speaking: [],
        }),
        spyOn(voice, "embedVoiceLines").mockImplementation(async (input) =>
            input.spans.map((span) => timedLine(span.index, span.fromSec, span.index < 2 ? [1, 0] : [0, 1], "mic"))
        )
    );
    const preview = () =>
        proposeSpeakerLabels(opened, config.global.speakerLabels, undefined, {
            voiceOnly: true,
            applyAbove: config.global.suggest.applyAbove,
        });
    // Both legacy room seats cover the whole meeting. Bob joining the call at 5 s cannot identify Alice at 0 s.
    expect(await preview()).toEqual([]);

    record.seats.room = [alice.person, { name: bob.person, fromSec: 5 }];
    const labels = await preview();
    expect(labels[0]!.person).toBeUndefined();
    expect(labels[1]).toMatchObject({ index: 1, person: alice.person, reason: "named" });
    expect(labels.slice(2, 5).map(({ person, reason }) => [person, reason])).toEqual(
        Array(3).fill([bob.person, "exclusion"])
    );
    expect(readVoiceStore(record.project!).people).toEqual({});
    config.global.speakerLabels.seat.enabled = false;
    expect(await preview()).toEqual([]);
    record.items.push({
        id: "i1",
        kind: "speaker-range",
        status: "suggested",
        suggestedAt: record.start!,
        label: "Speaker 1",
        speaker: alice.person,
        fromSec: 0,
        toSec: 5,
        rules: [MeetingRule.SpeakingIndicator],
        confidence: 0.75,
    });
    expect((await preview())[1]?.person).toBe(alice.person);
    config.global.suggest.applyAbove = 0.8;
    expect(await preview()).toEqual([]);
    record.items.push({
        id: "i2",
        kind: "question",
        status: "confirmed",
        suggestedAt: record.start!,
        about: "speaker",
        fromSec: 0,
        toSec: 5,
        decides: [],
        choices: [alice.person],
        answer: alice.person,
        question: "Who spoke?",
        rules: [],
        decision: {
            token: "answer",
            actor: { kind: "listen" },
            entry: { action: "answer", question: "i2" },
            previous: { status: "suggested" },
        },
    });
    expect((await preview())[1]?.person).toBe(alice.person);
    record.items[1]!.decision!.actor = { kind: "agent", harness: "fixture", session: null };
    expect(await preview()).toEqual([]);
    expect(readVoiceStore(record.project!).people).toEqual({});
});

test("voice preview names a legacy room occupant before joining and after leaving the call", async () => {
    const { record, opened } = await sampledMeeting("legacy-room-call-stay-fixture");
    record.seats = { room: [alice.person, bob.person], remote: [] };
    addVoicePrint(record.project!, bob.person, { ...basePrint, sourceSha: "legacy-room-training" }, "fixture-model");
    spies.push(spyOn(voices, "voiceReadMeeting").mockResolvedValue(opened));
    const { speakerLabels, suggest } = meetingsConfigSchema.parse({}).global;
    speakerLabels.seat.enabled = false;
    const preview = await preparePreviewLabels({
        opened,
        settings: speakerLabels,
        presence: [
            { name: alice.person, fromSec: 0, toSec: 15 },
            { name: bob.person, fromSec: 5, toSec: 10 },
        ],
    });
    const labels = await preview(speakerLabels.voice, suggest.applyAbove);
    expect(labels.map(({ index, person, reason }) => [index, person, reason])).toEqual([
        [0, bob.person, "named"],
        [1, bob.person, "named"],
        [2, bob.person, "named"],
    ]);
});

test("threshold preview rescores a shared seat from local voice evidence without saving embeddings", async () => {
    const { opened, record, embed } = await sampledMeeting("threshold-seeds-fixture");
    // Only Alice appears in the source attendance. Bob shares her saved room seat.
    record.seats = { room: [alice.person, bob.person], remote: [] };
    record.items.push({
        id: "i1",
        kind: "speaker-range",
        status: "suggested",
        suggestedAt: record.start!,
        label: "Speaker 1",
        speaker: alice.person,
        fromSec: 0,
        toSec: 5,
        rules: [MeetingRule.SpeakingIndicator],
        confidence: 0.75,
        evidence: { transcriptLine: 0 },
    });
    spies.push(spyOn(voices, "voiceReadMeeting").mockResolvedValue(opened));
    const config = meetingsConfigSchema.parse({ global: { speakerLabels: { voice: { compute: { workers: 1 } } } } });
    spies.push(spyOn(opened, "config").mockResolvedValue(config));
    const { speakerLabels } = config.global;
    const enrollment = spyOn(voiceLibraryModule, "readVoiceLibrary");
    spies.push(enrollment);
    const score = await preparePreviewLabels({ opened, settings: speakerLabels, presence: await opened.presence() });
    expect((await score(speakerLabels.voice, 0.8))[1]?.person).toBeUndefined();
    expect((await score(speakerLabels.voice, 0.7))[1]).toMatchObject({ person: alice.person, reason: "named" });
    expect((await score(speakerLabels.voice, 0.72))[1]?.person).toBe(alice.person);
    expect(enrollment).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls.map(([options]) => options.cachePath)).toEqual([""]);
    expect(readVoiceStore(record.project!).people).toEqual({});
});

test("a human-confirmed range seeds a line only when it spans the whole line", async () => {
    const { record, opened } = await sampledMeeting("whole-line-seed-fixture");
    record.seats = { room: [alice.person, bob.person], remote: [] };
    const meeting = await opened.meeting();
    meeting.transcript = [0, 5, 10, 15].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "Hello." }));
    const config = meetingsConfigSchema.parse({});
    config.global.speakerLabels.seat.enabled = false;
    spies.push(
        spyOn(opened, "presence").mockResolvedValue([
            { name: alice.person, fromSec: 0, toSec: 20 },
            { name: bob.person, fromSec: 0, toSec: 20 },
        ]),
        spyOn(opened, "evidence").mockResolvedValue({
            segments: [{ startSec: 0, endSec: 20, channel: "mic" }],
            files: [],
            speaking: [],
        }),
        spyOn(voice, "embedVoiceLines").mockImplementation(async (input) =>
            input.spans.map((span) => timedLine(span.index, span.fromSec, span.index < 2 ? [1, 0] : [0, 1], "mic"))
        )
    );
    const decision = {
        token: "answer",
        actor: { kind: "listen" as const },
        entry: { action: "answer" as const, question: "i2" },
        previous: { status: "suggested" as const },
    };
    const range = {
        id: "i1",
        kind: "speaker-range" as const,
        status: "confirmed" as const,
        suggestedAt: record.start!,
        label: "Speaker 1",
        speaker: alice.person,
        fromSec: 0,
        toSec: 0,
        rules: [],
        decision,
    };
    record.items.push(range, {
        id: "i2",
        kind: "question",
        status: "confirmed",
        suggestedAt: record.start!,
        about: "speaker",
        fromSec: 0,
        toSec: 0,
        decides: ["i1"],
        choices: [alice.person],
        answer: alice.person,
        question: "Who spoke?",
        rules: [],
        decision,
    });
    const preview = () =>
        proposeSpeakerLabels(opened, config.global.speakerLabels, undefined, {
            voiceOnly: true,
            applyAbove: config.global.suggest.applyAbove,
        });

    // The decision ends where the 5 s line starts: the rest of the line was never decided.
    expect(await preview()).toEqual([]);
    range.toSec = 5;
    expect((await preview())[1]?.person).toBe(alice.person);
});

test("exclusion survives the preview contract and creates a question even for short lines and a zero question budget", async () => {
    const { record, opened, store } = await sampledMeeting("exclusion-question-fixture");
    const meeting = await opened.meeting();
    const config = meetingsConfigSchema.parse({});
    const labels: ReturnType<typeof nameByVoice> = [0, 1].map((index) => ({
        labeler: "voice",
        index,
        seat: "mic",
        person: bob.person,
        reason: "exclusion",
        score: 0.45,
        margin: 0.45,
        next: { person: alice.person, score: 0 },
    }));
    const rows = labels.map((row) => ({
        ...row,
        labeler: "voice" as const,
        fromSec: row.index * 5,
        toSec: row.index * 5 + 5,
        text: "First.",
        current: "Speaker 1",
    }));
    expect(voicesPreview.result.parse({ meeting: record.id, lines: rows }).lines).toEqual(rows);
    const fresh = suggestItems({
        record,
        meeting,
        labels,
        rules: ["speakers"],
        dictionary: { abbrExpansion: "every", entries: [] },
        sourceWords: [],
        questionBudget: 0,
        now: record.start!,
    });
    // toMatchObject below may write its matchers into the received objects, so the store gets a copy taken first.
    const stored = structuredClone(fresh);
    const ranges = fresh.filter((item) => item.kind === "speaker-range" && item.evidence?.reason === "exclusion");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({
        status: "suggested",
        confidence: 0.45,
        rules: [MeetingRule.VoiceEmbedding],
        evidence: { margin: 0.45 },
    });
    expect(fresh.find((item) => item.kind === "question")).toMatchObject({
        choices: expect.arrayContaining([bob.person]),
        decides: ranges.map((item) => item.id),
        evidence: { reason: "exclusion" },
    });
    await store.update(record.id, { command: "suggest", change: "fixture" }, (current) => {
        current.items.push(...stored);
    });
    const bulk = await new DecisionJournal({ store }).plan({
        meeting: record.id,
        actor: { kind: "cli" },
        action: { kind: "confirm", items: [], minConfidence: 0 },
    });
    expect(
        bulk.skipped.filter((skip) => ranges.some((range) => range.id === skip.id)).map((skip) => skip.needs)
    ).toEqual(["listen", "listen"]);
    record.items.push(...ranges);
    expect(correctionsOf(record, config, { withSuggested: true, applyAbove: 0, format: "json" }).ranges).toEqual([]);
    ranges[0]!.status = "confirmed";
    expect(correctionsOf(record, config, { withSuggested: true, applyAbove: 0, format: "json" }).ranges).toHaveLength(
        1
    );
});

test("a live speaking indicator enrols its own line only when the existing rule clears applyAbove", async () => {
    const { opened, record } = await sampledMeeting("indicator-seed-fixture");
    record.seats = { room: ["Owner Example"], remote: [{ name: alice.person }, { name: bob.person }] };
    const presence = [alice, bob].map((stay) => ({ name: stay.person, fromSec: 0, toSec: 30 }));
    spies.push(
        spyOn(opened, "evidence").mockResolvedValue({
            selfName: "Owner Example",
            files: [],
            segments: [
                { startSec: 0, endSec: 5, channel: "system", liveName: alice.person },
                { startSec: 5, endSec: 20, channel: "system" },
            ],
            speaking: [{ tSec: 0, speaking: [alice.person] }],
        }),
        spyOn(opened, "sound").mockResolvedValue({
            tracks: [],
            slice: (line) => ({
                fileFromSec: line.fromSec,
                fileToSec: line.toSec,
                track: "source-call",
                path: "call.wav",
                channel: 0,
                clock: "source",
            }),
        })
    );
    const labelers = meetingsConfigSchema.parse({}).global.speakerLabels;
    labelers.seat.enabled = false;
    const preview = (applyAbove: number) =>
        proposeSpeakerLabels(opened, labelers, presence, { voiceOnly: true, applyAbove });
    const rows = await preview(0.7);
    expect(rows[0]?.person).toBeUndefined();
    expect(rows[1]).toMatchObject({ reason: "named", person: alice.person });
    expect(await preview(0.71)).toEqual([]);
});

test("only human speaker answers wholly containing a line persist prints; Undo reopens the store", async () => {
    const { record, opened } = await sampledMeeting("answer-voice-fixture");
    const question = {
        id: "i1",
        kind: "question" as const,
        about: "speaker" as const,
        group: "rules" as const,
        question: "Who speaks?",
        choices: [alice.person],
        fromSec: 0,
        toSec: 0,
        evidence: { endSec: 5 },
        status: "confirmed" as const,
        suggestedAt: "2026-11-01T10:00:00Z",
        answer: alice.person,
        rules: [],
    };
    const entry = journalEntrySchema.parse({
        token: "d1",
        at: "2026-11-01T10:00:00Z",
        meeting: record.id,
        question: "i1",
        actor: { kind: "listen" },
        action: { kind: "answer", question: "i1", answer: alice.person },
        changes: [{ id: "i1", after: question }],
    });
    expect(
        await saveAnsweredVoiceSamples({
            opened,
            entry: { ...entry, actor: { kind: "agent", harness: "fixture", session: null } },
        })
    ).toEqual([]);
    const changes = await saveAnsweredVoiceSamples({ opened, entry });
    expect(changes).toHaveLength(1);
    expect(readVoiceStore(record.project!).people[alice.person]?.samples[0]?.fromSec).toBe(0);
    undoAnsweredVoiceSamples(changes);
    expect(readVoiceStore(record.project!).people[alice.person]).toBeUndefined();
    addVoicePrint(
        record.project!,
        alice.person,
        { ...changes[0]!.after, confirmedAt: "2026-11-01T11:00:00Z" },
        "fixture-model"
    );
    undoAnsweredVoiceSamples(changes);
    expect(readVoiceStore(record.project!).people[alice.person]?.samples).toHaveLength(1);
});

test("a person's confirm of a name the voice model gave keeps that line as a sample; a confirm by threshold keeps none", async () => {
    const { record, opened } = await sampledMeeting("confirm-voice-fixture");
    const suggested = {
        id: "i7",
        kind: "speaker-range" as const,
        label: "Speaker 1",
        fromSec: 5,
        toSec: 5,
        speaker: alice.person,
        status: "suggested" as const,
        confidence: 0.71,
        rules: [MeetingRule.VoiceEmbedding],
        evidence: { labeler: "voice", reason: "named", seat: "mic", score: 0.71, transcriptLine: 1, endSec: 10 },
        suggestedAt: "2026-11-01T10:00:00Z",
    };
    const confirmed = {
        ...suggested,
        status: "confirmed" as const,
        decidedAt: "2026-11-01T10:05:00Z",
        decision: { token: "d7", previous: { status: "suggested" as const } },
    };
    const entry = journalEntrySchema.parse({
        token: "d7",
        at: "2026-11-01T10:05:00Z",
        meeting: record.id,
        actor: { kind: "window" },
        action: { kind: "confirm", items: ["i7"] },
        decided: ["i7"],
        changes: [{ id: "i7", before: suggested, after: confirmed }],
    });
    expect(
        await saveAnsweredVoiceSamples({
            opened,
            entry: { ...entry, action: { kind: "confirm", items: ["i7"], minConfidence: 0.5 } },
        })
    ).toEqual([]);
    expect(
        await saveAnsweredVoiceSamples({
            opened,
            entry: { ...entry, changes: [{ id: "i7", before: suggested, after: { ...confirmed, rules: [] } }] },
        })
    ).toEqual([]);
    const changes = await saveAnsweredVoiceSamples({ opened, entry });
    // Only the line the range names (5 s to 10 s), at the voice's seat, under the range's id.
    expect(
        changes.map((change) => [change.person, change.after.fromSec, change.after.toSec, change.after.question])
    ).toEqual([[alice.person, 5, 10, "i7"]]);
    expect(readVoiceStore(record.project!).people[alice.person]?.samples).toHaveLength(1);
    undoAnsweredVoiceSamples(changes);
    expect(readVoiceStore(record.project!).people[alice.person]).toBeUndefined();
});
