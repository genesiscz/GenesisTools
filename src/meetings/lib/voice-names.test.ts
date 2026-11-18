import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import * as voice from "@genesiscz/utils/meetings/voice";
import { addVoicePrint, readVoiceStore, type VoicePrint, type VoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { Storage } from "@genesiscz/utils/storage";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { journalEntrySchema } from "./decision-actions";
import { identifiedDepartures } from "./departure";
import { itemWhat } from "./item-text";
import { OpenedMeeting } from "./opened-meeting";
import * as soundModule from "./sound";
import { meetingSound } from "./sound";
import { mergeLineLabels, speakerLabelRule } from "./speaker-labels";
import type { LabelContext } from "./speaker-labels/types";
import { embedSeatLines, voiceLabeler } from "./speaker-labels/voice";
import { nameByVoice, type VoiceLine } from "./voice-names";
import { saveAnsweredVoiceSamples, undoAnsweredVoiceSamples } from "./voice-samples";

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
test("a stranger on a seat of one vetoes its owner, and never supplies a different name", () => {
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

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
    for (const mock of spies.splice(0).reverse()) {
        mock.mockRestore();
    }
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
test("only human speaker answers wholly containing a line persist prints; Undo reopens the store", async () => {
    const store = new MeetingStore(new Storage("voice-answer-fixture"));
    const record = await store.create(
        {
            title: "Planning",
            start: "2026-11-01T10:00:00Z",
            createdBy: "new",
            project: "answer-voice-fixture",
            seats: { room: [alice.person], remote: [] },
        },
        { command: "new", change: "fixture" }
    );
    const opened = OpenedMeeting.of(store, record);
    const audio = `${store.folder(record.id)}/fixture.wav`;
    writeFileSync(audio, "fixture audio");
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
    spies.push(
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
        }),
        spyOn(voice, "embedVoiceLines").mockImplementation(async (options) =>
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
        )
    );
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
