import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import * as voice from "@genesiscz/utils/meetings/voice";
import {
    correctVoiceSample,
    insertVoiceSample,
    readVoiceLibrary,
    sourceForVoicePrint,
    type VoicePrint,
    voiceLineKeys,
} from "@genesiscz/utils/meetings/voice-library";
import { duplicateMeeting } from "./duplicate";
import { OpenedMeeting } from "./opened-meeting";
import { InProcessMeetingsClient } from "./service/client";
import * as sound from "./sound";

const finch = "Finch Example";
const lark = "Lark Example";
const model = "fixture-voice";
const start = "2026-11-01T10:00:00Z";
const restore: Array<() => void> = [];
let previousHome: string;

beforeEach(() => {
    previousHome = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "seat-voice-")));
});
afterEach(() => {
    for (const undo of restore.splice(0).reverse()) {
        undo();
    }
    env.testing.set("GENESIS_TOOLS_HOME", previousHome);
});

interface Example {
    share: number;
    embedding: number[];
    at?: number;
    model?: string;
}

async function fixture(examples: Example[], fields: Partial<MeetingRecord> = {}) {
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Finch review",
            start,
            createdBy: "new",
            project: "garden",
            sources: { wisprflow: { meetingId: "garden-review" } },
            participants: [finch, lark].map((name) => ({ name, from: ["calendar"] })),
            ...fields,
        },
        { command: "new", change: "fixture" }
    );
    const meeting = {
        sourceMeetingId: "garden-review",
        title: record.title,
        start,
        folders: [],
        speakers: [],
        participants: [],
        transcript: examples.map(({ at }, i) => ({
            id: `entry-${i}`,
            speaker: "Speaker 1",
            text: "One line.",
            startSec: at ?? i * 4,
        })),
    };
    const folder = store.folder(record.id);
    const audio = join(folder, "sound.wav");
    writeFileSync(audio, "fixture for the embedding reader");
    const evidence = join(folder, "evidence");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "sentinel"), "keep");
    const transcript = spyOn(OpenedMeeting.prototype, "meeting").mockResolvedValue(meeting);
    const reads = spyOn(OpenedMeeting.prototype, "evidence").mockResolvedValue({
        segments: [{ channel: "mic", startSec: 0, endSec: 200 }],
        speaking: [],
        files: [],
    });
    const shares = new Map(meeting.transcript.map((line, i) => [line.startSec, examples[i]!.share]));
    const energy = spyOn(OpenedMeeting.prototype, "energy").mockResolvedValue({
        share: Object.assign(() => undefined, { raw: (from: number) => shares.get(from) }),
    });
    const inputs = spyOn(sound, "readSoundInputs").mockResolvedValue({
        folder,
        rows: [],
        timelineZeroMs: 0,
        tracks: "source",
        source: { path: audio, source: "wisprflow", layout: "right-mic", durationSec: 200 },
    });
    const embed = spyOn(voice, "embedVoiceLines").mockImplementation(async ({ spans, channels, audioPath }) =>
        spans.map(({ index, fromSec, toSec }) => ({
            index,
            channels: channels.map((channel) => ({
                ...channel,
                fromSec,
                toSec,
                source: { audioPath, size: 1, mtimeMs: 1 },
                quality: "ready",
                model: examples[index]!.model ?? model,
                embedding: examples[index]!.embedding,
            })),
        }))
    );
    const client = new InProcessMeetingsClient({ deps: { store: () => new MeetingStore() } });
    restore.push(...[transcript, reads, energy, inputs, embed].map((spy) => () => spy.mockRestore()), () =>
        client.close()
    );
    return {
        store,
        record,
        embed,
        keys: voiceLineKeys(meeting),
        preview: (id = record.id) => client.call("meeting.seats.suggest", { meeting: id }),
        evidenceFiles: () =>
            readdirSync(evidence)
                .sort()
                .map((file) => [file, readFileSync(join(evidence, file))]),
    };
}

function sample(person: string, options: Partial<VoicePrint> & { seat: VoicePrint["seat"]; lineKey?: string }) {
    const { lineKey, ...overrides } = options;
    const print: VoicePrint = {
        meeting: "training",
        sourceSha: "fixture-digest",
        track: options.seat === "mic" ? "source-mic" : "source-call",
        fromSec: 40,
        toSec: 44,
        embedding: person === finch ? [1, 0] : [0, 1],
        confirmedAt: start,
        ...overrides,
    };
    const receipt = insertVoiceSample({
        project: "training-garden",
        model,
        owner: { name: person },
        source: sourceForVoicePrint(print, print.meeting, lineKey),
        origin: "confirm",
        acquiredBy: "manual",
        print,
    });
    if (receipt.status !== "added") {
        throw new Error(`Fixture sample was ${receipt.status}`);
    }
    return receipt.id;
}

const mic = { share: 0.95, embedding: [1, 0] };
const call = { share: 0.05, embedding: [0, 1] };

test("seat preview finds both unseated voices in one read-only batch per channel", async () => {
    const f = await fixture([mic, mic, call, call]);
    sample(finch, { seat: "mic" });
    sample(lark, { seat: "call" });
    const before = {
        evidence: f.evidenceFiles(),
        record: readFileSync(f.store.path(f.record.id)),
        library: readVoiceLibrary(),
        bytes: readFileSync(join(f.store.root, "voice-library", "library.json")),
    };
    const view = await f.preview();
    expect(view.current).toBeNull();
    expect(view.suggestion.seats).toEqual({ room: [finch], remote: [{ name: lark }] });
    expect(view.suggestion.people.map((p) => p.reason)).toEqual([
        expect.stringContaining("2 microphone, 0 call"),
        expect.stringContaining("0 microphone, 2 call"),
    ]);
    expect(
        f.embed.mock.calls.map(([batch]) => [batch.cachePath, batch.channels[0]!.channel, batch.spans.length]).sort()
    ).toEqual([
        ["", 0, 2],
        ["", 1, 2],
    ]);
    expect(new MeetingStore().read(f.record.id)?.seats).toBeUndefined();
    expect(readFileSync(f.store.path(f.record.id))).toEqual(before.record);
    expect(readVoiceLibrary()).toEqual(before.library);
    expect(readFileSync(join(f.store.root, "voice-library", "library.json"))).toEqual(before.bytes);
    expect(f.evidenceFiles()).toEqual(before.evidence);
});

test("one opposite-side match keeps the whole seat unsure and incompatible tracks, models and dimensions cannot vote", async () => {
    const f = await fixture([
        mic,
        mic,
        { ...call, embedding: [1, 0] },
        { ...mic, model: "other" },
        { ...mic, embedding: [1] },
    ]);
    sample(finch, { seat: "mic" });
    sample(finch, { seat: "call" });
    sample(lark, { seat: "mic", track: "mic-raw" });
    const { suggestion } = await f.preview();
    expect(suggestion.seats).toEqual({ room: [], remote: [] });
    expect(suggestion.people).toMatchObject([
        { name: finch, seat: "unsure", reason: expect.stringContaining("2 microphone, 1 call") },
        { name: lark, seat: "unsure", reason: expect.stringContaining("0 microphone, 0 call") },
    ]);
});

test("a copied target and a refused line cannot supply independent votes", async () => {
    const f = await fixture([mic, mic, call, call]);
    // The same print overlaps the first target and has the stable entry ID of the retimed second target.
    sample(finch, { seat: "mic", meeting: f.record.id, fromSec: 1, toSec: 3, lineKey: f.keys[1] });
    sample(lark, { seat: "call" });
    const bad = sample(lark, { seat: "call", meeting: f.record.id, fromSec: 8, toSec: 12, lineKey: f.keys[2] });
    correctVoiceSample({ kind: "reject", id: bad, reason: "bad-audio" });
    const copy = await duplicateMeeting({ store: f.store, ref: f.record.id, withoutItems: true });
    const { suggestion } = await f.preview(copy.id);
    expect(suggestion.seats).toEqual({ room: [], remote: [] });
    expect(suggestion.people).toMatchObject([
        { name: finch, seat: "unsure", reason: expect.stringContaining("0 microphone, 0 call") },
        { name: lark, seat: "unsure", reason: expect.stringContaining("0 microphone, 1 call") },
    ]);
});

test("overlapping positives count once and a weak microphone or tied rival contributes no vote", async () => {
    const f = await fixture([
        { ...mic, at: 0 },
        { ...mic, at: 4, model: "other" },
        { ...mic, at: 2 },
        { ...mic, at: 6, share: 0.69 },
        { ...mic, at: 10, embedding: [1, 1] },
    ]);
    sample(finch, { seat: "mic" });
    sample(lark, { seat: "mic", fromSec: 50, toSec: 54 });
    const { suggestion } = await f.preview();
    expect(suggestion.people).toMatchObject([
        { seat: "unsure", reason: expect.stringContaining("1 microphone, 0 call") },
        { seat: "unsure", reason: expect.stringContaining("0 microphone, 0 call") },
    ]);
});

test("saved seats and five decided lines take precedence over a new voice suggestion", async () => {
    const f = await fixture([mic, mic, call, call, call, call, call]);
    sample(finch, { seat: "mic" });
    sample(lark, { seat: "call" });
    expect((await f.preview()).suggestion.seats.room).toEqual([finch]);
    await f.store.update(f.record.id, { command: "set", change: "human seat" }, (current) => {
        current.seats = { room: [lark], remote: [] };
        current.items.push({
            kind: "speaker-range",
            id: "heard",
            status: "confirmed",
            label: "Speaker 1",
            speaker: finch,
            fromSec: 8,
            toSec: 28,
            rules: [],
            suggestedAt: start,
        });
    });
    const { suggestion } = await f.preview();
    expect(suggestion.seats).toEqual({ room: [lark], remote: [{ name: finch }] });
    expect(suggestion.people).toMatchObject([
        { name: finch, reason: "5 of 5 decided lines on the call." },
        { name: lark, reason: "Saved seat." },
    ]);
    expect(new MeetingStore().read(f.record.id)?.seats).toEqual({ room: [lark], remote: [] });
});
