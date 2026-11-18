import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toRpcTable } from "@genesiscz/utils/api-descriptor";
import { env } from "@genesiscz/utils/env";
import type { WatcherOptions } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError, MeetingsStateError } from "@genesiscz/utils/meetings/conflict";
import { ContactsPeopleSource } from "@genesiscz/utils/meetings/people-contacts";
import { MEETING_FILE, MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { readVoiceLibrary, type VoicePrint } from "@genesiscz/utils/meetings/voice-library";
import { addVoicePrint, readVoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { WordTimingCache, wordTimingFile } from "@genesiscz/utils/meetings/word-timing-cache";
import * as serviceHost from "@genesiscz/utils/rpc/service-host";
import { serviceEntryPath } from "@genesiscz/utils/rpc/service-host";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import * as atomicFile from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { Storage } from "@genesiscz/utils/storage/storage";
import { Command } from "commander";
import { z } from "zod";
import { renderLook } from "../../commands/look";
import { registerServeCommand } from "../../commands/serve";

import { CallTimeline } from "../call-timeline";
import { MeetingComments } from "../comments";
import { DecisionJournal } from "../decision-journal";
import { ocrPath } from "../frame-index";
import { lookMeeting } from "../look";
import { screenTextChanges } from "../look-screen";
import { OpenedMeeting } from "../opened-meeting";
import { projectRequired } from "../project";
import { persistClip } from "../saved-clip";
import { errorText } from "../shared";
import type { LinkedSource } from "../sources";
import { wordTimingModelFiles } from "../word-timing-worker";
import { generateWordTimings, type WordTimingGenerateDeps, type WordTimingInput } from "../word-timings";
import fixture from "./__fixtures__/meetings-protocol.json";
import {
    MEETINGS_EVENTS,
    MEETINGS_PROTOCOL,
    type MeetingsHello,
    meetingsApi,
    meetingsCodeStamp,
    meetingsMethod,
    NOTIFICATION_SCHEMAS,
    SUBSCRIBE,
    subscribeParamsSchema,
    subscribeResultSchema,
    UNSUBSCRIBE,
    VOICES_METHODS,
} from "./api";
import {
    InProcessMeetingsClient,
    LocalMeetingsEvents,
    type MeetingsClient,
    type MeetingsEventMessage,
    openMeetingsClient,
    SocketMeetingsClient,
} from "./client";
import { MeetingsFolderWatch } from "./folder-watch";
import { type MeetingsHandlerDeps, MeetingsServiceError } from "./handlers";
import { testDictionaryPhrase } from "./library-handlers";
import { previewTone } from "./moment-handlers";
import { voicesHandlers } from "./people-handlers";
import { readRows } from "./reads-handlers";
import { MEETINGS_CALL_BEAT_MS, type MeetingsServiceOptions, progressBeat, startMeetingsService } from "./service";

/** The code stamp of the tests' service and callers, so the fixture's hello does not name a checkout's path. */
const CODE = "0123456789ab";

test("a draft dictionary entry previews only the changed meeting lines without saving", async () => {
    const { store, source, config, linkedSource } = scratchStore();
    const original = await source.load("wf-2041");
    source.load = async () => ({
        ...original,
        transcript: [
            { startSec: 0, speaker: "Dana Example", text: "A glimmer here." },
            { startSec: 5, speaker: "Alex Example", text: "Nothing changes." },
            { startSec: 10, speaker: "Alex Example", text: "Another glimmer." },
        ],
    });
    const before = readFileSync(store.path(REVIEW.id), "utf8");
    const result = await testDictionaryPhrase(
        { phrase: "glimmer", meeting: REVIEW.id, entry: { type: "term", value: "Glimmer", spoken: ["glimmer"] } },
        { store: () => store, configStore: () => config, linkedSource }
    );
    expect(result.lines).toEqual([
        {
            index: 0,
            startSec: 0,
            endSec: 5,
            speaker: "Dana Example",
            before: "A glimmer here.",
            after: "A Glimmer here.",
        },
        {
            index: 2,
            startSec: 10,
            endSec: 15,
            speaker: "Alex Example",
            before: "Another glimmer.",
            after: "Another Glimmer.",
        },
    ]);
    expect(readFileSync(store.path(REVIEW.id), "utf8")).toBe(before);
    expect((await config.read()).global.dictionary.entries).toEqual([]);
});

test("threshold preview changes a 79% term at its two times and keeps decisions and the config byte-for-byte", async () => {
    const { store, source, linkedSource, config } = scratchStore();
    const original = await source.load("wf-2041");
    source.load = async () => ({
        ...original,
        transcript: [9, 22].map((startSec) => ({ startSec, speaker: "Speaker 1", text: "Read the blenwick now." })),
    });
    source.evidence = async () => null;
    await config.update((raw) => {
        raw.projects = { Atlas: {} };
        raw.languages = { cs: { wordCheck: "off" }, sk: { wordCheck: "off" } };
    });
    await store.update(REVIEW.id, { command: "fixture", change: "suggested spelling" }, (record) => {
        record.items = [
            {
                id: "i9",
                kind: "term",
                heard: "blenwick",
                proposed: "Blenwik",
                status: "suggested",
                confidence: 0.79,
                atSec: 9,
                rules: [MeetingRule.PhoneticTerm],
                suggestedAt: record.createdAt,
            },
            {
                id: "i10",
                kind: "term",
                heard: "blenwick",
                proposed: "Blenwik",
                status: "suggested",
                confidence: 0.65,
                atSec: 22,
                rules: [MeetingRule.PhoneticTerm],
                suggestedAt: record.createdAt,
            },
        ];
    });
    const recordBytes = readFileSync(store.path(REVIEW.id));
    const configBytes = readFileSync(config.path);
    const client = new InProcessMeetingsClient({
        deps: { store: () => store, configStore: () => config, linkedSource },
    });
    const preview = await client.call("meeting.thresholds.preview", {
        meeting: REVIEW.id,
        values: { "term.applyAbove": 0.8 },
    });
    expect(preview.changes).toContainEqual(
        expect.objectContaining({
            key: "saved:i9",
            kind: "term proposal",
            change: "changed",
            atSec: 9,
            text: "Read the blenwick now.",
            before: expect.objectContaining({ status: "applied", confidence: 0.79 }),
            after: expect.objectContaining({ status: "suggested", confidence: 0.79 }),
            reason: expect.stringContaining("0.7 → 0.8"),
        })
    );
    expect(preview.changes.filter((row) => row.kind === "transcript line").map((row) => row.atSec)).toEqual([9, 22]);
    expect(readFileSync(store.path(REVIEW.id))).toEqual(recordBytes);
    expect(readFileSync(config.path)).toEqual(configBytes);
});

test("R3 sampled call reviews split at an unmute and persist separate answer targets", async () => {
    const { store, source, linkedSource, config } = scratchStore();
    const original = await source.load("wf-2041");
    const remote = "Finch Example";
    const other = "Wren Example";
    source.load = async () => ({
        ...original,
        speakers: [],
        transcript: [0, 5].map((startSec) => ({
            startSec,
            speaker: "Voice",
            text: "Please review this proposal.",
        })),
    });
    source.evidence = async () => ({
        files: [],
        segments: [{ startSec: 0, endSec: 30, channel: "system" }],
        speaking: [
            { tSec: 0, speaking: [], muted: [other] },
            { tSec: 5, speaking: [], muted: [] },
        ],
    });
    await store.update(REVIEW.id, { command: "fixture", change: "two remote lines" }, (record) => {
        record.participants = [remote, other].map((name) => ({ name, from: ["fixture"] }));
        record.seats = { room: [], remote: [{ name: remote }, { name: other }] };
        record.items = [
            {
                kind: "speaker-range",
                id: "i1",
                status: "suggested",
                suggestedAt: record.createdAt,
                rules: ["RA"],
                speaker: remote,
                label: "Voice",
                fromSec: 0,
                toSec: 5,
                confidence: 0.55,
            },
        ];
    });
    const features = spyOn(await import("../listen-quality"), "qualityVoiceFeatures").mockResolvedValue([]);
    const client = new InProcessMeetingsClient({
        deps: { store: () => store, configStore: () => config, linkedSource },
    });
    try {
        const result = await client.call("meeting.listen.prepare", {
            meeting: REVIEW.id,
            group: "long-stretch",
            words: 1,
            below: 0.7,
        });
        expect(result.questions).toHaveLength(2);
        const saved = new MeetingStore(store.storage).read(REVIEW.id)!;
        const questions = saved.items.filter((item) => item.kind === "question");
        expect(questions[0]?.choices).not.toContain(other);
        expect(questions[1]?.choices).toContain(other);
        expect(questions[0]?.decides).toHaveLength(1);
        expect(questions[1]?.decides).toHaveLength(1);
        expect(questions[0]?.decides[0]).not.toBe(questions[1]?.decides[0]);
    } finally {
        features.mockRestore();
        client.close();
    }
});

test("lowering and raising the dictionary cutoff adds and removes the same timed proposal", async () => {
    const { store, source, linkedSource, config } = scratchStore();
    const original = await source.load("wf-2041");
    source.load = async () => ({ ...original, transcript: [{ startSec: 13, speaker: "Narrator", text: "klyxpart" }] });
    source.evidence = async () => null;
    await config.update((raw) => {
        raw.global = {
            dictionary: { entries: [{ type: "term", value: "klymport" }] },
            // The 0.75 proposal stays a suggestion, so a raised apply line is what moves it into the transcript.
            suggest: { terms: { phonetic: 1, applyAbove: 0.8 } },
        };
        raw.languages = { cs: { wordCheck: "off" }, sk: { wordCheck: "off" } };
    });
    const client = new InProcessMeetingsClient({
        deps: { store: () => store, configStore: () => config, linkedSource },
    });
    const preview = (values: Record<string, number>) =>
        client.call("meeting.thresholds.preview", { meeting: REVIEW.id, values });
    await expect(preview({ longStretchWords: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("longStretchWords");
    const added = await preview({ "fuzzy.suggest": 0.7 });
    const term = added.changes.find((row) => row.kind === "regenerated term proposal");
    expect(term).toMatchObject({ change: "added", atSec: 13, text: "klyxpart", after: { confidence: 0.75 } });
    await client.call("config.edit", { edits: [{ path: "global.suggest.terms.fuzzy.suggest", value: 0.7 }] });
    const removed = await preview({ "fuzzy.suggest": 0.8 });
    expect(removed.changes.find((row) => row.key === term!.key)).toMatchObject({
        change: "removed",
        before: term!.after,
    });
    const replaced = await preview({ "fuzzy.apply": 0.74, "fuzzy.suggest": 0.9 });
    expect(replaced.changes.find((row) => row.kind === "transcript line")?.after?.description).toContain("klymport");
    client.close();
});

test("look suppresses a global name where a confirmed label is meaningless", async () => {
    const { store, source, linkedSource } = scratchStore();
    const original = await source.load("wf-2041");
    source.load = async () => ({
        ...original,
        transcript: [5, 10, 15, 20].map((startSec) => ({ startSec, speaker: "Speaker 1", text: "Fixture line" })),
    });
    source.evidence = async () => null;
    const record = await store.update(
        REVIEW.id,
        { command: "fixture", change: "confirmed label decisions" },
        (current) => {
            current.speakers.labels["Speaker 1"] = "Alice Example";
            current.speakers.assignments = [
                { id: "a1", label: "Speaker 1", fromSec: 15, toSec: 15, person: "Dana Example", at: current.createdAt },
            ];
            current.items = [
                {
                    id: "i1",
                    kind: "label",
                    label: "Speaker 1",
                    fromSec: 10,
                    toSec: 25,
                    meaningless: true,
                    status: "confirmed",
                    rules: [],
                    suggestedAt: current.createdAt,
                },
                {
                    id: "i2",
                    kind: "speaker-range",
                    label: "Speaker 1",
                    fromSec: 20,
                    toSec: 20,
                    speaker: "Sam Example",
                    status: "confirmed",
                    rules: [],
                    suggestedAt: current.createdAt,
                },
            ];
        }
    );
    const opened = OpenedMeeting.of(store, record, linkedSource(record));
    const open = spyOn(OpenedMeeting, "of").mockReturnValue(opened);
    try {
        const result = await lookMeeting(store, { meeting: record.id, from: 0, to: 25 });
        expect(result.lines.map((line) => line.confirmedName)).toEqual([
            "Alice Example",
            null,
            "Dana Example",
            "Sam Example",
        ]);
    } finally {
        open.mockRestore();
    }
});

test("screen look parses only the requested window and viable display baselines in capture order", async () => {
    const { store } = scratchStore();
    const record = store.read(REVIEW.id)!;
    const timeline = CallTimeline.stored(record);
    const folder = store.folder(record.id);
    const file = ocrPath(folder);
    const row = (sec: number, text: string, displayId: number, failed?: string) =>
        SafeJSON.stringify({
            file: `frame-${sec}.jpg`,
            at: new Date(timeline.msAt(sec)).toISOString(),
            displayId,
            text,
            failed,
        });
    const distant = Array.from({ length: 64 }, (_, i) => row(30 + i, `Later ${i}`, 1));
    const initial = [
        row(9, "Wrong failed text", 1, "offline"),
        row(11, "Red fox", 1),
        ...distant,
        row(3, "Older baseline", 1),
        row(8, "First screen", 1),
        row(7, "Seen before", 2),
        row(10, "Second screen", 2),
    ];
    writeFileSync(file, `${initial.join("\n")}\n`);
    const parser = spyOn(SafeJSON, "parse");
    const read = () => screenTextChanges({ folder, timeline, fromSec: 10, toSec: 11 });
    try {
        expect(await read()).toEqual([
            { atSec: 10, displayId: 2, added: ["Second screen"], removed: ["Seen before"] },
            { atSec: 11, displayId: 1, added: ["Red fox"], removed: ["First screen"] },
        ]);
        expect(parser.mock.calls).toHaveLength(5);
        parser.mockClear();
        expect(await read()).toHaveLength(2);
        expect(parser.mock.calls).toHaveLength(5);
        writeFileSync(file, `${initial.join("\n")}\n${row(10, "Newly read", 1)}\n`);
        expect((await read())?.find((change) => change.displayId === 1 && change.atSec === 10)?.added).toEqual([
            "Newly read",
        ]);
    } finally {
        parser.mockRestore();
    }
});

test("the text look escapes source controls and can render a large section", () => {
    const answer: Parameters<typeof renderLook>[0] = {
        meeting: "meeting-fixture",
        fromSec: 0,
        toSec: 10,
        lines: [
            {
                index: 0,
                fromSec: 1,
                toSec: 2,
                label: "Speaker\u009b2K",
                text: "Note\r\nFake\u001b[2J",
                micShare: null,
                confirmedName: "A\u0007",
                suggestedName: null,
                voice: null,
                echoPair: null,
            },
        ],
        attendance: [{ name: "Person\u2028Name", fromSec: 0, toSec: 4 }],
        questions: [],
        items: [],
        screen: [
            { atSec: 3, displayId: 1, added: Array.from({ length: 150_000 }, () => "OCR\u001b[2J"), removed: ["old"] },
        ],
    };
    const text = renderLook(answer);
    expect(text).toContain(String.raw`Speaker\u009b2K`);
    expect(text).toContain(String.raw`Note\u000d\u000aFake\u001b[2J`);
    expect(text).toContain(String.raw`Person\u2028Name`);
    expect(text).toContain(String.raw`+ OCR\u001b[2J`);
    expect(text).not.toContain("\u001b");
    expect(answer.lines[0]!.text).toContain("\u001b");
});

test("threshold CLI lists sources, previews without saving and commits multiple global settings together", async () => {
    const { registerThresholdsCommand } = await import("../../commands/thresholds");
    const { store, linkedSource, config } = scratchStore();
    await config.update((raw) => {
        raw.projects = { Atlas: { dictionary: { fuzzy: { suggest: 0.82 } } } };
    });
    const client = new InProcessMeetingsClient({
        deps: { store: () => store, configStore: () => config, linkedSource },
    });
    const result = spyOn(out, "result").mockImplementation(() => undefined);
    const run = (args: string[]) => {
        const program = new Command().exitOverride();
        registerThresholdsCommand(program, (work) => work(client));
        return program.parseAsync(["thresholds", REVIEW.id, "--json", ...args], { from: "user" });
    };
    const bytes = readFileSync(config.path);
    try {
        await run([]);
        expect(String(result.mock.lastCall?.[0])).toContain("project Atlas dictionary.fuzzy.suggest");
        await run(["--set", "fuzzy.suggest=0.7", "--preview"]);
        expect(readFileSync(config.path)).toEqual(bytes);
        await expect(run(["--set", "term.applyAbove=0.8", "words.minOccurrences=1"])).rejects.toThrow(
            "words.minOccurrences"
        );
        expect(readFileSync(config.path)).toEqual(bytes);
        await run(["--set", "term.applyAbove=0.8", "--set", "words.minOccurrences=4"]);
        expect((await new MeetingsConfigStore(config.storage).read()).global.suggest).toMatchObject({
            terms: { applyAbove: 0.8 },
            words: { minOccurrences: 4 },
        });
    } finally {
        result.mockRestore();
        client.close();
    }
});

const closing: Array<() => void> = [];

afterEach(() => {
    for (const close of closing.splice(0).reverse()) {
        close();
    }
});

/** Two invented meetings of one day: one with a fake Wispr Flow source, one without a source. */
const REVIEW = {
    version: 1,
    id: "2026-11-03-1000-design-review",
    title: "Design review",
    project: "Atlas",
    labels: ["Checkout"],
    start: "2026-11-03T09:00:00.000Z",
    end: "2026-11-03T09:45:00.000Z",
    createdAt: "2026-11-03T09:46:00.000Z",
    createdBy: "link",
    sources: { wisprflow: { meetingId: "wf-2041" } },
    participants: [
        { name: "Dana Example", self: true, from: ["wisprflow"] },
        { name: "Alex Example", from: ["calendar"] },
    ],
    context: [],
    speakers: { labels: { "Speaker 2": "Alex Example" } },
    items: [
        {
            kind: "speaker-range",
            label: "Speaker 3",
            fromSec: 12,
            toSec: 30,
            speaker: "Alex Example",
            candidates: ["Alex Example", "Dana Example"],
            id: "i1",
            status: "suggested",
            confidence: 0.82,
            rules: ["presence"],
            suggestedAt: "2026-11-03T09:47:00.000Z",
        },
    ],
    history: [{ at: "2026-11-03T09:46:00.000Z", command: "link", change: "linked wisprflow:wf-2041" }],
};
const RETRO = {
    version: 1,
    id: "2026-11-03-1400-retro",
    title: "Retro",
    labels: [],
    start: "2026-11-03T13:00:00.000Z",
    createdAt: "2026-11-03T13:00:00.000Z",
    createdBy: "new",
    sources: {},
    participants: [],
    context: [],
    speakers: { labels: {} },
    items: [],
    history: [{ at: "2026-11-03T13:00:00.000Z", command: "new", change: "created" }],
};

/** The recording the fake source keeps: a real file, since the clip cache keys a clip by the file's time and size. */
const RECORDING = join(mkdtempSync(join(tmpdir(), "mtg-audio-")), "upload.ogg");
writeFileSync(RECORDING, "a recording");

function fakeSource(): TranscriptSource {
    const meeting: SourceMeeting = {
        sourceMeetingId: "wf-2041",
        title: "Design review",
        start: "2026-11-03T09:00:00.000Z",
        participants: [{ name: "Dana Example", self: true, from: ["wisprflow"] }],
        speakers: [],
        transcript: [
            { id: "l1", startSec: 2, speakerId: 1, speaker: "Dana Example", text: "Let us start with the checkout." },
            { id: "l2", startSec: 9, speakerId: 2, speaker: "Speaker 2", text: "The button moved to the right." },
        ],
        folders: [],
    };

    return {
        id: "wisprflow",
        label: "Fake",
        load: async () => meeting,
        revision: async () => "rev-7",
        describe: () => ({ meetingId: "wf-2041" }),
        dictionary: async () => [],
        recordingClock: async () => ({ startedAt: "2026-11-03T09:00:00.000Z" }),
        evidence: async () => ({ audioPath: RECORDING, segments: [], speaking: [], files: [] }),
        liveRecording: async () => null,
        calendarEntries: async () => ({ ok: true, from: "wisprflow", entries: [] }),
        folders: async () => [],
        meetingsBetween: async () => [
            {
                sourceMeetingId: "wf-2041",
                title: "Design review",
                start: "2026-11-03T09:00:00.000Z",
                hasTranscript: true,
            },
        ],
        meetingFolders: async () => [],
        folderWrite: { supported: false, reason: "fake", manualStep: "none" },
    };
}

let stores = 0;

/**
 * A scratch store with the two meetings, written as files (fixed times, so every answer is the same each run), and a
 * scratch meetings config for the library methods.
 */
/** REVIEW with one suggested speaker: line l2 (9 s) as Dana Example, at the fixture item's confidence (0.82). */
function seedSuggestedSpeaker(store: MeetingStore): void {
    const suggested = { ...REVIEW.items[0], label: "Speaker 2", fromSec: 9, toSec: 10, speaker: "Dana Example" };
    writeFileSync(store.path(REVIEW.id), SafeJSON.stringify({ ...REVIEW, items: [suggested] }, null, 2));
}

function scratchStore(): {
    store: MeetingStore;
    config: MeetingsConfigStore;
    linkedSource: (record: { id: string }) => LinkedSource | undefined;
    /** REVIEW's source: a test counts its loads. */
    source: TranscriptSource;
} {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-service-${process.pid}-${stores}`));
    const config = new MeetingsConfigStore(new Storage(`meetings-service-config-${process.pid}-${stores}`));

    for (const record of [REVIEW, RETRO]) {
        mkdirSync(store.folder(record.id), { recursive: true });
        writeFileSync(join(store.folder(record.id), MEETING_FILE), SafeJSON.stringify(record, null, 2));
    }

    const source = fakeSource();
    return {
        store,
        config,
        source,
        linkedSource: (record) => (record.id === REVIEW.id ? { source, sourceMeetingId: "wf-2041" } : undefined),
    };
}

test("P2 scoped voice selection pins legacy numbers, rolls back failed corrections and refuses an occupied destination", async () => {
    const home = env.tools.getHome();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "voices-service-")));
    const { store } = scratchStore();
    const client = new InProcessMeetingsClient({ deps: { store: () => new MeetingStore(store.storage) } });
    const name = "Lark Example";
    const other = "Wren Example";
    const person = { name };
    const seed: VoicePrint = {
        meeting: "elsewhere",
        fromSec: 0,
        toSec: 4,
        seat: "mic",
        track: "source-mic",
        sourceSha: "clip",
        embedding: [1, 0],
        confirmedAt: "2026-11-01T12:00:00Z",
    };
    const get = (project: string) => readVoiceLibrary().library.samples.filter((s) => s.project === project);
    try {
        const x = await store.create(
            { createdBy: "new", title: "Review", start: seed.confirmedAt, project: "spring" },
            { command: "new", change: "fixture" }
        );
        const y = await store.create(
            { createdBy: "new", title: "Workshop", start: seed.confirmedAt, project: "winter" },
            { command: "new", change: "fixture" }
        );
        for (const { id } of [x, y]) {
            await store.update(id, { command: "test", change: "seed proposals" }, (record) => {
                const proposed = {
                    id: "i1",
                    kind: "speaker-range" as const,
                    speaker: name,
                    label: "S1",
                    fromSec: 0,
                    toSec: 4,
                    status: "suggested" as const,
                    rules: [MeetingRule.VoiceEmbedding],
                    suggestedAt: seed.confirmedAt,
                };
                record.items = [
                    proposed,
                    { ...proposed, id: "i2", status: "confirmed" },
                    { ...proposed, id: "i3", speaker: other },
                ];
            });
        }
        addVoicePrint("spring", name, { ...seed, meeting: x.id }, "fixture-model");
        addVoicePrint("winter", name, { ...seed, meeting: y.id }, "fixture-model");
        addVoicePrint("winter", name, { ...seed, meeting: y.id, fromSec: 10, toSec: 14 }, "fixture-model");
        const global = await client.call("voices.list", { scope: { kind: "all" }, person: name });
        expect(global.people).toHaveLength(1);
        expect(global.people[0]!.samples).toHaveLength(3);
        expect(global.people[0]!.samples.every((s) => !("embedding" in s))).toBe(true);
        expect(
            (await client.call("voices.list", { scope: { kind: "meeting", meeting: x.id }, person: name })).people[0]
                ?.samples
        ).toHaveLength(1);
        const selection = { project: "spring", person: name, sample: 1 };
        const first = await client.call("voices.remove", { ...selection, preview: true });
        const xId = get("spring")[0]!.id;
        const yIds = get("winter").map((s) => s.id);
        expect(first.ids).toEqual([xId]);
        expect(first.affected.map((row) => row.meeting).sort()).toEqual([x.id, y.id].sort());
        addVoicePrint("spring", other, { ...seed, meeting: x.id, fromSec: 20, toSec: 25 }, "fixture-model");
        await expect(client.call("voices.remove", { ...selection, planToken: first.planToken })).rejects.toThrow(
            "Stale"
        );
        const plan = await client.call("voices.remove", { ...selection, preview: true });
        const file = toolDataDir("meetings", "voice-library", "library.json");
        const before = readFileSync(file);
        const saved = [x, y].map((r) => readFileSync(store.path(r.id)));
        const write = atomicFile.atomicWriteFileSync;
        const fail = spyOn(atomicFile, "atomicWriteFileSync").mockImplementation((path, bytes, opt) => {
            if (path === file) {
                throw new Error("fixture publication failure");
            }
            return write(path, bytes, opt);
        });
        try {
            await expect(client.call("voices.remove", { ...selection, planToken: plan.planToken })).rejects.toThrow(
                "fixture publication failure"
            );
        } finally {
            fail.mockRestore();
        }
        expect(readFileSync(file)).toEqual(before);
        expect([x, y].map((r) => readFileSync(store.path(r.id)))).toEqual(saved);
        const removed = await client.call("voices.remove", { ...selection, planToken: plan.planToken });
        expect(removed.ids).toEqual([xId]);
        expect(get("winter").map((s) => s.id)).toEqual(yIds);
        expect(get("spring").some((s) => s.id === xId)).toBe(false);
        for (const r of [x, y]) {
            expect(store.read(r.id)!.items.map((i) => i.id)).toEqual(["i2", "i3"]);
        }
        expect(await client.call("voices.undo", { token: removed.token! })).toMatchObject({
            status: "applied",
            ids: [xId],
        });
        expect(get("spring")[0]).toMatchObject({ id: xId, owner: person });
        const dir = toolDataDir("meetings", "voices");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "occupied.json"),
            SafeJSON.stringify({
                version: 1,
                model: "fixture-model",
                people: { [other]: { samples: [{ ...seed, meeting: x.id }] } },
            })
        );
        const occupied = readVoiceLibrary().library.samples;
        expect(await client.call("voices.move", { id: xId, to: { name: other } })).toMatchObject({ status: "refused" });
        expect(readVoiceLibrary().library.samples).toEqual(occupied);
    } finally {
        client.close();
        env.testing.set("GENESIS_TOOLS_HOME", home);
    }
});

test("voice descriptors validate the shared handlers: lists and removal previews write nothing; removal retires suggested names", async () => {
    const { store, linkedSource } = scratchStore();
    const record = await store.create(
        { title: "Voices", start: "2026-11-01T10:00:00Z", createdBy: "new", project: "service-voice-fixture" },
        { command: "new", change: "fixture" }
    );
    await store.update(record.id, { command: "new", change: "fixture" }, (current) => {
        current.items = [
            {
                id: "i1",
                kind: "speaker-range",
                fromSec: 1,
                toSec: 4,
                label: "Speaker 1",
                speaker: "Alice Example",
                status: "suggested",
                rules: [MeetingRule.VoiceEmbedding],
                suggestedAt: "2026-11-01T10:00:00Z",
            },
        ];
    });
    addVoicePrint(
        record.project!,
        "Alice Example",
        {
            meeting: record.id,
            sourceSha: "fixture",
            seat: "mic",
            track: "source-mic",
            fromSec: 1,
            toSec: 4,
            embedding: [1, 0],
            confirmedAt: "2026-11-01T10:00:00Z",
        },
        "fixture-model"
    );
    const table = toRpcTable({ methods: VOICES_METHODS }, voicesHandlers(store, { linkedSource }));
    const context = {
        hello: () => ({
            protocol: MEETINGS_PROTOCOL,
            code: "fixture",
            methods: [],
            events: [],
            version: "fixture",
        }),
    };
    const before = readFileSync(store.path(record.id));
    const listed = await table.call("voices.list", { project: record.project }, context);
    expect(VOICES_METHODS[0].result.parse(listed).people[0]).toMatchObject({
        person: "Alice Example",
        samples: [{ sample: 1, track: "source-mic" }],
    });
    const plan = await table.call(
        "voices.remove",
        { project: record.project, person: "Alice Example", preview: true },
        context
    );
    expect(plan).toMatchObject({ removed: 1, affected: [{ meeting: record.id, item: "i1" }] });
    expect(readVoiceStore(record.project!).people["Alice Example"]?.samples).toHaveLength(1);
    expect(readFileSync(store.path(record.id))).toEqual(before);
    await expect(
        table.call("voices.sample", { project: record.project, person: "Alice Example", sample: 0 }, context)
    ).rejects.toThrow();
    await table.call("voices.remove", { project: record.project, person: "Alice Example" }, context);
    expect(new MeetingStore(store.storage).read(record.id)?.items).toEqual([]);
    expect(readVoiceStore(record.project!).people["Alice Example"]).toBeUndefined();
    for (const name of ["voices.list", "voices.preview", "voices.sample"]) {
        expect(VOICES_METHODS.find((method) => method.name === name)?.effect).toBe("read");
    }
});

test("voices.workers answers what auto means from the CPU sample; voices.preview and voices.apply send the voice pass's progress", async () => {
    const { store, linkedSource } = scratchStore();
    const table = toRpcTable(
        { methods: VOICES_METHODS },
        voicesHandlers(store, { linkedSource, freeCores: async () => ({ performanceCores: 12, idleCores: 2.6 }) })
    );
    const updates: Array<{ fraction?: number; label?: string }> = [];
    const context = {
        hello: () => ({ protocol: MEETINGS_PROTOCOL, code: "fixture", methods: [], events: [], version: "fixture" }),
        progress: (update: { fraction?: number; label?: string }) => updates.push(update),
    };
    expect(await table.call("voices.workers", {}, context)).toEqual({ auto: 2, performanceCores: 12, idleCores: 2.6 });
    expect(VOICES_METHODS.find((method) => method.name === "voices.workers")?.effect).toBe("read");

    const labels = await import("../speaker-labels");
    const { voiceProgressForMeeting } = await import("../speaker-labels/voice");
    const propose = spyOn(labels, "proposeSpeakerLabels").mockImplementation(async (opened) => {
        voiceProgressForMeeting.get(opened)?.(3, 3);
        return [];
    });
    closing.push(() => propose.mockRestore());
    const suggest = await import("../suggest-run");
    const run = spyOn(suggest, "runSuggest").mockImplementation(async ({ onProgress }) => {
        onProgress?.(4, 4);
        return { fresh: [], retired: [], warnings: [] };
    });
    closing.push(() => run.mockRestore());
    await table.call("voices.preview", { meeting: REVIEW.id }, context);
    await table.call("voices.apply", { meeting: REVIEW.id }, context);
    expect(updates).toEqual([
        { fraction: 1, label: "Voices: 3 of 3 lines" },
        { fraction: 1, label: "Voices: 4 of 4 lines" },
    ]);
});

test("a running call repeats its newest step every beat, so a client's deadline measures silence, never length", async () => {
    const sent: Array<{ fraction?: number; label?: string }> = [];
    let wake = () => {};
    // Wait for the beats themselves, with a generous deadline, so a slow runner that delays a timer cannot fail it.
    const sentUntil = (enough: () => boolean) =>
        new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error(`only ${sent.length} beats arrived`)), 5_000);
            wake = () => {
                if (enough()) {
                    clearTimeout(deadline);
                    wake = () => {};
                    resolve();
                }
            };
            wake();
        });
    const beat = progressBeat((update) => {
        sent.push(update);
        wake();
    }, 30);
    await sentUntil(() => sent.length >= 1);
    expect(sent[0]).toEqual({});
    const step = { fraction: 0.5, label: "Voices: 1 of 2 lines" };
    beat.progress(step);
    // The step goes out at once, then the beat repeats it at least twice.
    await sentUntil(() => sent.filter((update) => update.label).length >= 3);
    beat.stop();
    const stopped = sent.length;
    await Bun.sleep(100);
    expect(sent.slice(1).every((update) => update.label === step.label)).toBe(true);
    expect(sent.length).toBe(stopped);
    expect(MEETINGS_CALL_BEAT_MS).toBeLessThan(60_000 / 2);

    // Over a socket: a call that works longer than the client's deadline still answers while the beat runs.
    const { service } = await startService({
        beatMs: 30,
        deps: {
            freeCores: async () => {
                await Bun.sleep(400);
                return { performanceCores: 12, idleCores: 9 };
            },
        },
    });
    const client = await SocketMeetingsClient.connect(service.entry, hello);
    closing.push(() => client.close());
    const beats: Array<{ fraction?: number; label?: string }> = [];
    // The work takes twice the deadline; beats every 30 ms leave a delayed timer a wide margin under it.
    const answer = await client.call(
        "voices.workers",
        {},
        { timeoutMs: 200, onProgress: (update) => beats.push(update) }
    );
    expect(answer.auto).toBe(4);
    expect(beats.length).toBeGreaterThanOrEqual(2);
});

async function questionRowsFixture() {
    const fixture = scratchStore();
    const original = await fixture.source.load("wf-2041");
    fixture.source.load = async () => ({
        ...original,
        transcript: [
            { startSec: 0, speaker: "Speaker 2", text: "word ".repeat(70).trim() },
            { startSec: 10, speaker: "Speaker 3", text: "A different label." },
            { startSec: 20, speaker: "Speaker 2", text: "Same doubt here." },
            { startSec: 30, speaker: "Speaker 2", text: "Outside range." },
            { startSec: 40, speaker: "Speaker 3", text: "Other label again." },
            { startSec: 50, speaker: "Speaker 2", text: "Not asked yet." },
        ],
    });
    const base = { status: "suggested", rules: [], confidence: 0.4, suggestedAt: REVIEW.createdAt };
    await fixture.store.update(REVIEW.id, { command: "fixture", change: "question rows" }, (record) => {
        record.items = meetingRecordSchema.parse({
            ...record,
            items: [
                ...[
                    ["i1", 0, 10],
                    ["i2", 30, 30],
                    ["i3", 20, 20],
                    ["i4", 50, 50],
                ].map(([id, fromSec, toSec]) => ({
                    ...base,
                    id,
                    kind: "speaker-range",
                    label: "Speaker 2",
                    fromSec,
                    toSec,
                    speaker: "Alex Example",
                    evidence: { signature: "shape", choices: ["Alex Example", "Dana Example"] },
                })),
                {
                    ...base,
                    id: "i5",
                    kind: "question",
                    about: "speaker",
                    fromSec: 0,
                    toSec: 5,
                    question: "Who speaks?",
                    choices: ["Alex Example", "Dana Example"],
                    decides: ["i1", "i2"],
                    signature: "shape",
                    priority: 1,
                    evidence: { labels: ["Speaker 2"] },
                },
                {
                    ...base,
                    id: "i6",
                    kind: "question",
                    about: "speaker",
                    fromSec: 20,
                    toSec: 25,
                    question: "Who speaks?",
                    choices: ["Alex Example", "Dana Example"],
                    decides: ["i3"],
                    signature: "shape",
                    priority: 1,
                    evidence: { labels: ["Speaker 2"] },
                },
            ],
        }).items;
    });
    const deps = {
        store: () => fixture.store,
        config: () => fixture.config.read(),
        linkedSource: fixture.linkedSource,
    };
    return { ...fixture, deps };
}

test("question rows keep each decided line, including targets outside the question and all its text", async () => {
    const { store, deps } = await questionRowsFixture();
    const result = await readRows({ meeting: REVIEW.id }, store, deps);
    const lines = result.questionDetails?.find((row) => row.id === "i5")?.decidedLines;
    expect(lines?.map((line) => line.index)).toEqual([0, 3]);
    expect(lines?.[0]?.text).toBe("word ".repeat(70).trim());
    expect(lines?.[1]).toEqual({ index: 3, startSec: 30, endSec: 40, speaker: "Speaker 2", text: "Outside range." });
});

test("question impact counts distinct lines and words and includes unasked ranges with the same doubt", async () => {
    const { store, deps } = await questionRowsFixture();
    const result = await readRows({ meeting: REVIEW.id }, store, deps);
    expect(result.questionDetails?.find((row) => row.id === "i5")?.impact).toEqual({
        lines: 2,
        words: 72,
        sameDoubtLines: 4,
    });
});

test("answered rows name the lines actually raised by that answer after reopening the journal", async () => {
    const { store, deps } = await questionRowsFixture();
    await new DecisionJournal({ store, listenBelow: 0.9, ledger: () => undefined }).apply({
        meeting: REVIEW.id,
        actor: { kind: "window" },
        action: { kind: "answer", question: "i5", answer: "Alex Example" },
    });
    const reopened = new MeetingStore(store.storage);
    const result = await readRows({ meeting: REVIEW.id }, reopened, deps);
    expect(result.questionDetails?.find((row) => row.id === "i5")?.raisedLines?.map((line) => line.index)).toEqual([
        2, 5,
    ]);
    expect(result.questionDetails?.find((row) => row.id === "i6")?.raisedLines).toBeUndefined();
});

test("meeting rows expose a stored attendance failure even without a readable transcript", async () => {
    const { store, config, source, linkedSource } = scratchStore();
    source.load = async () => {
        throw new Error("Fixture transcript unavailable");
    };
    await store.update(
        REVIEW.id,
        { command: "attendance-failed", change: "Fixture attendance not found" },
        () => undefined
    );
    const result = await readRows({ meeting: REVIEW.id }, new MeetingStore(store.storage), {
        config: () => config.read(),
        linkedSource,
    });
    // One short sentence for the window; the stored text is the detail behind it (U3).
    expect(result.attendanceWarning).toBe("The call did not say who joined, so the people come from the transcript.");
    expect(result.attendanceDetail).toBe("Fixture attendance not found");
});

test("line evidence names the active swaps that skipped each source line", async () => {
    const { store, deps } = await questionRowsFixture();
    await store.update(REVIEW.id, { command: "fixture", change: "swap skips" }, (record) => {
        record.items[0]!.evidence = { swap: { skipped: [10, 40] } };
        record.items[1]!.evidence = { swap: { skipped: [40] } };
        record.items[2]!.evidence = { swap: { skipped: [10] } };
        record.items[2]!.status = "rejected";
        // A swap that names its labels skips only lines under one of them.
        record.items[3]!.evidence = { swap: { skipped: [10, 20, 40], selfLabel: "Speaker 2", otherLabel: "Nobody" } };
    });
    const result = await readRows({ meeting: REVIEW.id }, store, deps);
    expect(result.lineEvidence?.map((line) => line.swapSkippedBy)).toEqual([
        undefined,
        ["i1"],
        ["i4"],
        undefined,
        ["i1", "i2"],
        undefined,
    ]);
});

test("line evidence warns only outside known remote windows and omits a warning when presence is unknown", async () => {
    const { store, deps, source } = await questionRowsFixture();
    const meeting = await source.load("wf-2041");
    meeting.transcript[1]!.speaker = "Dana Example";
    source.load = async () => meeting;
    const unknown = await readRows({ meeting: REVIEW.id }, store, deps);
    expect(unknown.lineEvidence).toBeUndefined();
    await store.update(REVIEW.id, { command: "fixture", change: "remote windows" }, (record) => {
        record.seats = { room: ["Dana Example"], remote: [{ name: "Alex Example", fromSec: 20, toSec: 40 }] };
    });
    const result = await readRows({ meeting: REVIEW.id }, store, deps);
    expect(result.lineEvidence?.map((line) => line.noRemotePresent)).toEqual([
        true,
        undefined,
        undefined,
        undefined,
        true,
        true,
    ]);
});

test("line evidence returns measured call level, echo and microphone share per line, leaving missing measurements absent", async () => {
    const { store, deps } = await questionRowsFixture();
    const share = Object.assign((fromSec: number) => (fromSec === 20 ? undefined : 0.25), {
        acoustic: (fromSec: number) =>
            fromSec === 20
                ? undefined
                : {
                      callRms: 0.1 + fromSec / 1000,
                      echoOfCall: 0.8,
                      correlation: 0.9,
                      lagMs: 10,
                      gain: 0.4,
                      rawMicRms: 0.2,
                      cleanMicRms: 0.05,
                      quality: "linear-estimate" as const,
                  },
    });
    const energy = spyOn(OpenedMeeting.prototype, "energy").mockResolvedValue({ share });
    try {
        const result = await readRows({ meeting: REVIEW.id }, store, deps);
        expect(result.lineEvidence?.[0]).toMatchObject({
            index: 0,
            micShare: 0.25,
            callRms: 0.1,
            echoOfCall: 0.8,
            acousticQuality: "linear-estimate",
        });
        expect(result.lineEvidence?.[1]?.callRms).toBe(0.11);
        expect(result.lineEvidence?.[2]).toEqual({ index: 2, startSec: 20, endSec: 30 });
    } finally {
        energy.mockRestore();
    }
});

/** A stand-in for @parcel/watcher: `raise` hands the folder watch the events a write of these paths would raise. */
function fakeFolderEvents(): {
    subscribe: NonNullable<WatcherOptions["subscribe"]>;
    raise: (...paths: string[]) => void;
} {
    let deliver: ((paths: string[]) => void) | undefined;
    return {
        subscribe: async (_dir, callback) => {
            deliver = (paths) =>
                callback(
                    null,
                    paths.map((path) => ({ type: "update", path }))
                );
            return { unsubscribe: async () => {} };
        },
        raise: (...paths) => deliver?.(paths),
    };
}

/** The events a subscription hears, in order: `next` waits for the next one (2 s at most), `left` lists the unread. */
function eventQueue() {
    const unread: MeetingsEventMessage[] = [];
    const waiting: Array<(event: MeetingsEventMessage) => void> = [];
    return {
        push: (event: MeetingsEventMessage) => {
            const resolve = waiting.shift();

            if (resolve) {
                resolve(event);
            } else {
                unread.push(event);
            }
        },
        next: (): Promise<MeetingsEventMessage> => {
            const first = unread.shift();

            if (first) {
                return Promise.resolve(first);
            }

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("no meetings event within 2 s")), 2000);
                waiting.push((event) => {
                    clearTimeout(timer);
                    resolve(event);
                });
            });
        },
        left: () => [...unread],
    };
}

/** A service dir short enough for a Unix socket path. */
function serviceDir(): string {
    return mkdtempSync(join(tmpdir(), "mtg-"));
}

const hello: MeetingsHello = { role: "cli", protocol: MEETINGS_PROTOCOL, code: CODE, pid: 4242 };

/** The time every decision in these tests is made at, so the fixture's entries read the same each run. */
const NOW = new Date("2026-11-03T10:00:00.000Z");
/** A cut that writes a stand-in WAV, as ffmpeg would; it reports half way once. */
const fakeCut: NonNullable<MeetingsHandlerDeps["cut"]> = async (options) => {
    options.onProgress?.(0.5);
    writeFileSync(options.outPath, "RIFF");
};
/** The one contact of the tests' address book. */
const SKY = {
    given_name: "Sky",
    family_name: "Example",
    organization_name: "Harbor Works",
    email_addresses: [{ value: "sky@example.com" }],
};
/** The pid of a `listen --subscribe-answers --with-comments` the tests say runs; every other pid is gone. */
const LISTENER_PID = 4343;
const quietDeps: MeetingsHandlerDeps = {
    localSourceAudio: { sources: [], live: async () => undefined },
    now: () => NOW,
    listenerAlive: (pid) => pid === LISTENER_PID,
    ledger: () => undefined,
    readLedger: () => [],
    cut: fakeCut,
    probe: async () => ({ tracks: 1, channels: 2, durationSec: 45 }),
    hasFfmpeg: () => true,
    tone: async (_sound, path) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "RIFF");
    },
    // Invented folder and calendar lists, so a suggestion never reads Wispr Flow or the Calendar app of this Mac.
    suggestionReads: () => ({
        sourceFolders: async () => ["Design", "Ops"],
        calendarNames: async () => ({ names: ["Work", "Home"] }),
    }),
    // An address book with one invented contact, so a people answer never reads this Mac's Contacts.
    contacts: () =>
        new ContactsPeopleSource({
            authorized: async () => ({ status: "authorized", authorized: true }),
            search: async (query) => (query.toLowerCase().startsWith("sk") ? [SKY] : []),
            list: async () => [SKY],
        }),
    // Ten seconds of 100 ms blocks: quiet, then the left channel loud from 4 s to 5 s.
    energy: async () => ({
        left: Float32Array.from({ length: 100 }, (_, block) => (block >= 40 && block < 50 ? 800 : 100)),
        right: Float32Array.from({ length: 100 }, () => 200),
    }),
};

async function startService(
    options: {
        dir?: string;
        watch?: MeetingsServiceOptions["watch"];
        deps?: Partial<MeetingsHandlerDeps>;
        beatMs?: number;
    } = {}
) {
    const { store, config, linkedSource, source } = scratchStore();
    const dir = options.dir ?? serviceDir();
    const start = await startMeetingsService({
        dir,
        store: () => store,
        configStore: () => config,
        linkedSource,
        // A source list or a link reads the fake, never this Mac's Wispr Flow.
        sources: async () => source,
        idleMs: 0,
        code: CODE,
        watch: options.watch ?? false,
        ...(options.beatMs === undefined ? {} : { beatMs: options.beatMs }),
        ...quietDeps,
        ...options.deps,
    });

    if (start.status !== "started") {
        throw new Error("the meetings service did not start");
    }

    closing.push(() => start.service.stop("test end"));
    return { dir, store, config, source, service: start.service };
}

interface Adapter {
    client: MeetingsClient;
    emit: (event: "meeting.changed", params: { meeting: string; parts: Array<"show" | "transcript"> }) => void;
    store: MeetingStore;
    /** The meetings config the library methods change. */
    config: MeetingsConfigStore;
    /** REVIEW's linked source (this process's object, also behind the socket adapter). */
    source: TranscriptSource;
}

const ADAPTERS: Record<"socket" | "in-process", (caller?: MeetingsHello) => Promise<Adapter>> = {
    socket: async (caller = hello) => {
        const { service, store, config, source } = await startService();
        const client = await SocketMeetingsClient.connect(service.entry, caller);
        closing.push(() => client.close());
        return { client, store, config, source, emit: (event, params) => service.emit(event, params) };
    },
    "in-process": async (caller = hello) => {
        const { store, config, linkedSource, source } = scratchStore();
        const events = new LocalMeetingsEvents();
        const client = new InProcessMeetingsClient({
            hello: caller,
            deps: { store: () => store, configStore: () => config, linkedSource, ...quietDeps },
            events,
        });
        closing.push(() => client.close());
        return { client, store, config, source, emit: (event, params) => events.emit(event, params) };
    },
};

/** An agent's hello: its decisions name its harness and session. */
const agentHello: MeetingsHello = {
    role: "agent",
    harness: "claude-code",
    session: "11111111-2222-4333-8444-555555555555",
    protocol: MEETINGS_PROTOCOL,
    code: CODE,
};

/** The error a call rejects with. */
async function failure(call: Promise<unknown>): Promise<Error> {
    try {
        await call;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }

    throw new Error("the call did not fail");
}

describe.each(Object.keys(ADAPTERS) as Array<keyof typeof ADAPTERS>)("the Meetings service, %s adapter", (kind) => {
    test("seat suggestions read raw channel energy on confirmed lines without changing the record", async () => {
        const { client, store, source } = await ADAPTERS[kind]();
        const meeting = await source.load("wf-2041");
        source.load = async () => ({
            ...meeting,
            transcript: Array.from({ length: 5 }, (_, startSec) => ({ startSec, speaker: "S1", text: "A line." })),
        });
        await store.update(REVIEW.id, { command: "test", change: "confirmed lines" }, (record) => {
            record.items = [
                {
                    kind: "speaker-range",
                    id: "i1",
                    status: "confirmed",
                    label: "S1",
                    fromSec: 0,
                    toSec: 4,
                    speaker: "Moss Example",
                    suggestedAt: record.start,
                    rules: [],
                },
            ];
        });
        const energy = spyOn(OpenedMeeting.prototype, "energy").mockResolvedValue({
            share: Object.assign(() => 0.1, { raw: () => 0.9 }),
        });
        closing.push(() => energy.mockRestore());
        const before = readFileSync(store.path(REVIEW.id));
        const view = await client.call("meeting.seats.suggest", { meeting: REVIEW.id });
        expect(view.suggestion.seats.room).toEqual(["Dana Example", "Moss Example"]);
        expect(view.suggestion.people).toContainEqual({
            name: "Moss Example",
            seat: "room",
            reason: "5 of 5 decided lines on the microphone.",
            confidence: 1,
        });
        expect(view.suggestion.people).toContainEqual({
            name: "Alex Example",
            seat: "unsure",
            reason: "No call roster entry or decided lines.",
            confidence: 0,
        });
        expect(readFileSync(store.path(REVIEW.id))).toEqual(before);
    });
    test("suggest refuses without a project before running and runs once a project is set", async () => {
        const { client, store, config } = await ADAPTERS[kind]();
        const suggest = await import("../suggest-run");
        const run = spyOn(suggest, "runSuggest").mockResolvedValue({
            fresh: [],
            retired: [],
            warnings: ["Fixture warning"],
        });
        closing.push(() => run.mockRestore());
        const record = meetingRecordSchema.parse({ ...REVIEW, project: undefined });
        writeFileSync(store.path(record.id), SafeJSON.stringify(record, null, 2));
        const before = readFileSync(store.path(record.id));
        const text = projectRequired(record, await config.read());
        expect(text).toContain("This meeting has no project. Suggestions use the project's dictionary.");

        const error = await failure(client.call("meeting.suggest", { meeting: record.id }));
        expect(error).toBeInstanceOf(MeetingsServiceError);
        expect(error).toMatchObject({ code: "project-required", message: text });
        expect(run).not.toHaveBeenCalled();
        expect(readFileSync(store.path(record.id))).toEqual(before);

        writeFileSync(store.path(record.id), SafeJSON.stringify(REVIEW, null, 2));
        expect(await client.call("meeting.suggest", { meeting: record.id })).toEqual({
            added: 0,
            warnings: ["Fixture warning"],
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0].record.project).toBe(REVIEW.project);
    });

    test("meeting.suggest forwards voice progress including the last line, without a notification per clip", async () => {
        const { client } = await ADAPTERS[kind]();
        const suggest = await import("../suggest-run");
        const run = spyOn(suggest, "runSuggest").mockImplementation(async ({ onProgress }) => {
            const clock = spyOn(performance, "now").mockReturnValue(0);
            try {
                for (const done of [0, 1, 2, 25]) {
                    onProgress?.(done, 2000);
                }
                clock.mockReturnValue(250);
                onProgress?.(26, 2000);
                onProgress?.(2000, 2000);
            } finally {
                clock.mockRestore();
            }
            return { fresh: [], retired: [], warnings: [] };
        });
        closing.push(() => run.mockRestore());
        const updates: Array<{ fraction?: number; label?: string }> = [];
        await client.call("meeting.suggest", { meeting: REVIEW.id }, { onProgress: (update) => updates.push(update) });
        expect(updates.map(({ fraction, label }) => [fraction, label])).toEqual([
            [0, "Voices: 0 of 2000 lines"],
            [25 / 2000, "Voices: 25 of 2000 lines"],
            [26 / 2000, "Voices: 26 of 2000 lines"],
            [1, "Voices: 2000 of 2000 lines"],
        ]);
    });

    test("meeting.suggest stops when its caller cancels: the run's signal aborts and the call rejects", async () => {
        const { client } = await ADAPTERS[kind]();
        const suggest = await import("../suggest-run");
        let seen: AbortSignal | undefined;
        const run = spyOn(suggest, "runSuggest").mockImplementation(async ({ signal }) => {
            seen = signal;
            await new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            return { fresh: [], retired: [], warnings: [] };
        });
        closing.push(() => run.mockRestore());
        const controller = new AbortController();
        const call = client.call("meeting.suggest", { meeting: REVIEW.id }, { signal: controller.signal });
        for (let waited = 0; waited < 3000 && !seen; waited += 10) {
            await Bun.sleep(10);
        }
        expect(seen?.aborted).toBe(false);
        controller.abort();
        await expect(call).rejects.toThrow();
        // Over a socket the service hears `$/cancel` a moment after the caller gave up.
        for (let waited = 0; waited < 3000 && !seen?.aborted; waited += 10) {
            await Bun.sleep(10);
        }
        expect(seen?.aborted).toBe(true);
    });

    test("threshold previews apply only what each threshold allows, from one source load, persisting nothing", async () => {
        const { client, store, source } = await ADAPTERS[kind]();
        // The 0.5 and 0.7 previews apply the suggested speaker at 0.82; the 1 preview only shows it.
        seedSuggestedSpeaker(store);
        const before = readFileSync(store.path(REVIEW.id));
        const configBefore = SafeJSON.stringify(await new MeetingsConfigStore().read());
        const load = spyOn(source, "load");
        const result = await client.call("meeting.transcript", { ref: REVIEW.id, previewThresholds: [0.5, 0.7, 1] });
        // The corrections, the indicator and the three previews share one opened meeting.
        expect(load).toHaveBeenCalledTimes(1);
        load.mockRestore();
        expect(result.previews?.map((preview) => preview.threshold)).toEqual([0.5, 0.7, 1]);
        expect(
            result.previews?.map((preview) => preview.entries.find((entry) => entry.startSec === 9)?.speaker)
        ).toEqual(["Dana Example", "Dana Example", "[Dana Example: 82 %]"]);
        expect(readFileSync(store.path(REVIEW.id))).toEqual(before);
        // No threshold is kept as the rendering preference.
        expect(SafeJSON.stringify(await new MeetingsConfigStore().read())).toBe(configBefore);
    });

    test("rows use the saved threshold across three confidence bands and a one-off override", async () => {
        const { client, store, config } = await ADAPTERS[kind]();
        await config.update((raw) => {
            raw.global = { suggest: { applyAbove: 0.85 } };
        });
        const items = [0.5, 0.7, 0.9].map((confidence, index) => ({
            ...REVIEW.items[0],
            id: `i${index + 1}`,
            confidence,
            speaker: "River Example",
        }));
        writeFileSync(store.path(REVIEW.id), SafeJSON.stringify({ ...REVIEW, items }));
        const guesses = async (applyAbove?: number) =>
            (await client.call("meeting.rows", { meeting: REVIEW.id, applyAbove })).rows
                .filter((row) => row.guess)
                .map((row) => row.id);
        expect(await guesses()).toEqual(["i1", "i2"]);
        expect(await guesses(0.7)).toEqual(["i1"]);
        expect(await guesses(0.5)).toEqual([]);
        expect((await config.read()).global.suggest.applyAbove).toBe(0.85);
    });

    test("a long-stretch preparation asks about lines below the threshold the caller gives", async () => {
        const { client, store, config } = await ADAPTERS[kind]();
        // The fixture's upload is no real audio: the voice features are not what this test is about.
        const quality = await import("../listen-quality");
        const features = spyOn(quality, "qualityVoiceFeatures").mockResolvedValue([]);
        closing.push(() => features.mockRestore());
        // The suggested speaker at 0.82 is unsure below 0.9, sure below 0.8 (and the default 0.7).
        seedSuggestedSpeaker(store);
        const prepare = (below: number) =>
            client.call("meeting.listen.prepare", { meeting: REVIEW.id, group: "long-stretch", words: 1, below });
        expect((await prepare(0.8)).questions).toEqual([]);
        expect((await prepare(0.9)).questions).toHaveLength(1);
        seedSuggestedSpeaker(store);
        await config.update((raw) => {
            raw.global = { suggest: { applyAbove: 0.9 } };
        });
        expect(
            (await client.call("meeting.listen.prepare", { meeting: REVIEW.id, group: "long-stretch", words: 1 }))
                .questions
        ).toHaveLength(1);
    });

    test("meeting-local people persist device and half-open stays and remove through either adapter", async () => {
        const { client, store } = await ADAPTERS[kind]();
        await client.call("meeting.people.edit", {
            meeting: REVIEW.id,
            action: "add",
            name: "River Example",
            fromSec: 3,
            toSec: 8,
            atMic: true,
        });
        const reopened = new MeetingStore(store.storage).read(REVIEW.id)!;
        expect(reopened.participants.find((person) => person.name === "River Example")?.from).toContain("user");
        expect(reopened.attendance?.people).toContainEqual({
            name: "River Example",
            fromSec: 3,
            toSec: 8,
            joinedAtExact: true,
            leftAtExact: true,
        });
        expect(reopened.seats?.room).toContainEqual({ name: "River Example", fromSec: 3, toSec: 8 });
        expect(reopened.seats?.microphones?.find((group) => group.id === "self")?.people).toContain("River Example");
        await client.call("meeting.people.edit", { meeting: REVIEW.id, action: "remove", name: "River Example" });
        expect(
            new MeetingStore(store.storage)
                .read(REVIEW.id)!
                .participants.some((person) => person.name === "River Example")
        ).toBe(false);
    });

    test("meetings.list answers the list rows, the whole records with full, and filters like list --json", async () => {
        const { client } = await ADAPTERS[kind]();

        expect(client.kind).toBe(kind);
        expect(await client.call("meetings.list", {})).toEqual([
            {
                id: RETRO.id,
                title: "Retro",
                start: RETRO.start,
                labels: [],
                sources: [],
                context: 0,
                items: { suggested: 0, confirmed: 0, rejected: 0 },
            },
            {
                id: REVIEW.id,
                title: "Design review",
                start: REVIEW.start,
                end: REVIEW.end,
                project: "Atlas",
                labels: ["Checkout"],
                sources: ["wisprflow"],
                context: 0,
                items: { suggested: 1, confirmed: 0, rejected: 0 },
            },
        ]);
        expect((await client.call("meetings.list", { project: "Atlas", full: true })).map((row) => row.id)).toEqual([
            REVIEW.id,
        ]);
        expect((await client.call("meetings.list", { limit: 1 })).map((row) => row.id)).toEqual([RETRO.id]);
    });

    test("meeting-local people edit persists stays and canonical device groups through either adapter", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const saved = await client.call("meeting.people.edit", {
            meeting: REVIEW.id,
            name: "Eli Example",
            action: "add",
            atMic: true,
            fromSec: 60,
            toSec: 120,
        });
        expect(saved.seats?.microphones?.find((group) => group.id === "self")?.people).toEqual([
            "Dana Example",
            "Eli Example",
        ]);
        const reopened = new MeetingStore(store.storage).resolve(REVIEW.id)!;
        expect(reopened.participants.find((person) => person.name === "Eli Example")?.stays).toEqual([
            { fromSec: 60, toSec: 120, source: "hand", leaveSource: "hand", confidence: 1 },
        ]);
        expect(reopened.attendance?.people).toContainEqual({
            name: "Eli Example",
            fromSec: 60,
            toSec: 120,
            joinedAtExact: true,
            leftAtExact: true,
        });
        await client.call("meeting.people.edit", { meeting: REVIEW.id, name: "Eli Example", action: "remove" });
        expect(
            new MeetingStore(store.storage)
                .resolve(REVIEW.id)!
                .participants.some((person) => person.name === "Eli Example")
        ).toBe(false);
    });

    test("meeting.show answers the record by id or prefix; a missing or ambiguous ref is refused with its code", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const record = await client.call("meeting.show", { ref: "2026-11-03-10" });

        expect(record).toEqual(meetingRecordSchema.parse(REVIEW));
        const missing = await failure(client.call("meeting.show", { ref: "nope" }));
        expect(missing).toBeInstanceOf(MeetingsServiceError);
        expect(missing).toMatchObject({ code: "meeting-not-found" });
        expect(errorText(missing)).toBe(
            `[meeting-not-found] No meeting "nope" in ${store.root}. List them: tools meetings list. Look in the other stores: tools meetings locate nope`
        );
        const ambiguous = await failure(client.call("meeting.show", { ref: "2026-11-03" }));
        expect(ambiguous).toMatchObject({ code: "meeting-ref" });
        expect(errorText(ambiguous)).toBe(`[meeting-ref] "2026-11-03" fits 2 meetings: ${RETRO.id}, ${REVIEW.id}`);
    });

    test("meeting.transcript answers the corrected lines; a meeting without a source keeps its state code", async () => {
        const { client } = await ADAPTERS[kind]();
        const transcript = await client.call("meeting.transcript", { ref: REVIEW.id });

        expect(transcript.meeting).toBe(REVIEW.id);
        expect(transcript.entries.map((entry) => [entry.speaker, entry.text])).toEqual([
            ["Dana Example", "Let us start with the checkout."],
            ["Alex Example", "The button moved to the right."],
        ]);
        const none = await failure(client.call("meeting.transcript", { ref: RETRO.id }));
        expect(none).toBeInstanceOf(MeetingsStateError);
        expect(errorText(none)).toStartWith(`[no-transcript-source] ${RETRO.id} has no source with a transcript.`);
    });

    test("meeting.revisions answers one token per window part, the same twice when nothing changed", async () => {
        const { client } = await ADAPTERS[kind]();
        const first = await client.call("meeting.revisions", { ref: REVIEW.id });

        expect(Object.keys(first)).toEqual(["meeting", "show", "transcript", "speakers", "timeline"]);
        expect(first.meeting).toBe(REVIEW.id);
        expect(await client.call("meeting.revisions", { ref: REVIEW.id })).toEqual(first);
    });

    test("a bad param is refused before any handler, with the same sentence", async () => {
        const { client } = await ADAPTERS[kind]();
        const bad = await failure(client.call("meetings.list", { limit: 0 }));

        expect(bad).toMatchObject({ code: "failed" });
        expect(bad.message).toStartWith("meetings.list: limit:");
    });

    test("a subscription hears its meeting's events and not another meeting's", async () => {
        const { client, emit } = await ADAPTERS[kind]();
        const heard: MeetingsEventMessage[] = [];
        const stop = await client.subscribe({ meeting: REVIEW.id, events: ["meeting.changed"] }, (event) =>
            heard.push(event)
        );
        emit("meeting.changed", { meeting: RETRO.id, parts: ["show"] });
        emit("meeting.changed", { meeting: REVIEW.id, parts: ["show", "transcript"] });
        // A call after the emits: the socket delivers in order, so the notifications came before its answer.
        await client.call("meetings.list", { limit: 1 });
        stop();
        emit("meeting.changed", { meeting: REVIEW.id, parts: ["show"] });
        await client.call("meetings.list", { limit: 1 });

        expect(heard).toEqual([
            { method: "meeting.changed", params: { meeting: REVIEW.id, parts: ["show", "transcript"] } },
        ]);
    });

    test("service insertion preserves explicit duplicates and counts only new findings in mixed batches", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const finding = {
            kind: "speaker-range" as const,
            from: 0,
            to: 10,
            label: "Speaker 1",
            speaker: "Alex Example",
            confidence: 0.8,
            reason: "invented voice evidence",
        };
        const before = store.read(REVIEW.id)!.items.length;
        await client.call("decision.apply", { meeting: REVIEW.id, action: { kind: "add", findings: [finding] } });
        const retry = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "add", findings: [finding] },
        });
        expect(retry.entry).toBeUndefined();
        expect(new MeetingStore(store.storage).read(REVIEW.id)!.items).toHaveLength(before + 1);
        await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "add", findings: [finding], allowDuplicates: true },
        });
        expect(new MeetingStore(store.storage).read(REVIEW.id)!.items).toHaveLength(before + 2);
        const mixed = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "add", findings: [finding, { ...finding, speaker: "Dana Example" }] },
        });
        expect(mixed.entry?.changes).toHaveLength(1);
        expect(new MeetingStore(store.storage).read(REVIEW.id)!.history.at(-1)?.change).toBe("1 finding");
    });

    test("a seating save goes through decision.apply's set action, alone and beside another field", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const seats = { room: ["Dana Example"], remote: [{ name: "Alex Example", fromSec: 60, toSec: 600 }] };
        await client.call("decision.apply", { meeting: REVIEW.id, action: { kind: "set", seats } });
        expect(store.read(REVIEW.id)?.seats).toEqual(seats);
        const moved = { room: ["Dana Example", "Alex Example"], remote: [] };
        await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "set", seats: moved, title: "Seated review" },
        });
        expect(store.read(REVIEW.id)).toMatchObject({ seats: moved, title: "Seated review" });
        const rows = await client.call("journal.read", { meeting: REVIEW.id });
        expect(rows.entries).toHaveLength(2);
    });

    test("timed seats survive RPC and reopen without changing a legacy room row or its group", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const name = "Fern Example";
        const group = { id: "self", people: ["Reed Example", name] };
        const legacy = {
            room: ["Reed Example", name],
            remote: ["Ash Example", { name: "Empty Example", toSec: 0 }],
            microphones: [group],
        };
        const file = store.path(REVIEW.id);
        writeFileSync(file, SafeJSON.stringify({ ...store.read(REVIEW.id), seats: legacy }));
        const before = readFileSync(file);
        const shown = await client.call("meeting.show", { ref: REVIEW.id });
        expect(shown.seats?.room).toEqual(legacy.room);
        expect(shown.seats?.remote).toContainEqual({ name: "Empty Example", toSec: 0 });
        expect(readFileSync(file)).toEqual(before);
        const seats = {
            ...shown.seats!,
            room: ["Reed Example", { name, fromSec: 60, toSec: 120 }],
            remote: [{ name: "Ash Example" }, { name, toSec: 60 }, { name, fromSec: 150, label: "Guest" }],
        };
        await client.call("decision.apply", { meeting: REVIEW.id, action: { kind: "set", seats } });
        await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "set", title: "Review with seats" },
        });
        await client.call("meeting.people.edit", { meeting: REVIEW.id, action: "add", name, fromSec: 0, toSec: 80 });
        const reopened = new MeetingStore(store.storage).read(REVIEW.id);
        expect(reopened?.seats).toEqual(seats);
        expect(reopened?.attendance?.people).toContainEqual({
            name,
            fromSec: 0,
            toSec: 80,
            joinedAtExact: true,
            leftAtExact: true,
        });
        expect(SafeJSON.parse(readFileSync(file, "utf8"))).toMatchObject({ seats });
        const saved = readFileSync(file);
        for (const invalid of [
            { ...seats, remote: [{ name, toSec: 61 }] },
            { ...seats, remote: [{ name, fromSec: 5, toSec: 5 }] },
            { ...seats, remote: [{ name, fromSec: -1 }] },
        ]) {
            await expect(
                client.call("decision.apply", { meeting: REVIEW.id, action: { kind: "set", seats: invalid } })
            ).rejects.toThrow();
            expect(readFileSync(file)).toEqual(saved);
        }
        const visitor = "Ash Example";
        await client.call("meeting.people.edit", {
            meeting: REVIEW.id,
            action: "add",
            name: visitor,
            atMic: true,
            fromSec: 40,
            toSec: 50,
        });
        const moved = new MeetingStore(store.storage).read(REVIEW.id)?.seats;
        expect(moved?.room).toEqual([...seats.room, { name: visitor, fromSec: 40, toSec: 50 }]);
        expect(moved?.remote.filter((row) => row.name === visitor)).toEqual([
            { name: visitor, toSec: 40 },
            { name: visitor, fromSec: 50 },
        ]);
        expect(moved?.microphones).toEqual([{ ...group, people: [...group.people, visitor] }]);
    });

    test("service journal reads retain the copied meeting's provenance", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const { duplicateMeeting } = await import("../duplicate");
        await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "set", title: "Original fixture title" },
        });
        const copied = await duplicateMeeting({ store, ref: REVIEW.id, title: "Copied fixture title" });
        const rows = await client.call("journal.read", { meeting: copied.id });
        expect(rows.entries).toHaveLength(1);
        expect(rows.entries[0]).toMatchObject({ meeting: copied.id, copiedFrom: REVIEW.id });
        const { journalEntrySchema } = await import("../decision-actions");
        expect(journalEntrySchema.parse(rows.entries[0])).toHaveProperty("copiedFrom", REVIEW.id);
        const original = await client.call("journal.read", { meeting: REVIEW.id });
        expect(original.entries[0]).not.toHaveProperty("copiedFrom");
        expect(original.entries[0]?.meeting).toBe(REVIEW.id);
    });

    test("decision.apply decides as the hello's actor, tells decision.applied, and decision.revert undoes it", async () => {
        const { client, store } = await ADAPTERS[kind](agentHello);
        const heard: MeetingsEventMessage[] = [];
        await client.subscribe({ meeting: REVIEW.id, events: ["decision.applied", "decision.reverted"] }, (event) =>
            heard.push(event)
        );
        const applied = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i1"] },
            reason: "the calendar says so",
        });

        const agent = { kind: "agent", harness: "claude-code", session: agentHello.session };
        expect(applied.entry).toMatchObject({ actor: agent, reason: "the calendar says so", decided: ["i1"] });
        expect(store.read(REVIEW.id)?.items[0]).toMatchObject({ status: "confirmed", decision: { actor: agent } });
        const reverted = await client.call("decision.revert", { meeting: REVIEW.id, token: applied.entry!.token });
        expect(reverted.entry?.action).toEqual({ kind: "revert", token: applied.entry!.token });
        expect(store.read(REVIEW.id)?.items[0]?.status).toBe("suggested");
        const journal = await client.call("journal.read", { meeting: REVIEW.id });
        expect(journal.entries.map((entry) => [entry.action.kind, entry.revertedBy])).toEqual([
            ["revert", undefined],
            ["confirm", reverted.entry!.token],
        ]);
        await client.call("meetings.list", { limit: 1 });

        expect(heard.map((event) => event.method)).toEqual(["decision.applied", "decision.reverted"]);
        expect(heard[0]?.params).toEqual({ meeting: REVIEW.id, entry: applied.entry });
        expect(heard[1]?.params).toEqual({ meeting: REVIEW.id, token: applied.entry!.token, entry: reverted.entry });
    });

    test("question wording edits reach both adapters and undo without changing the answer", async () => {
        const { client, store } = await ADAPTERS[kind]();
        await store.update(REVIEW.id, { command: "test", change: "question wording" }, (record) => {
            record.items.push(
                ...meetingRecordSchema.parse({
                    ...record,
                    items: [
                        {
                            id: "i2",
                            kind: "question",
                            about: "term",
                            status: "confirmed",
                            answer: "API",
                            heard: "Ada",
                            question: "Which word?",
                            choices: ["API", "ADA"],
                            decides: ["i1"],
                            fromSec: 2,
                            toSec: 6,
                            rules: [],
                            suggestedAt: NOW.toISOString(),
                        },
                    ],
                }).items
            );
        });
        const before = store.read(REVIEW.id)!.items.find((item) => item.id === "i2");
        if (before?.kind !== "question") {
            throw new Error("fixture must hold a question");
        }
        const action = {
            kind: "rephrase",
            question: "i2",
            text: "Which interface did they name?",
            expectedText: "Which word?",
        } as const;
        const plan = await client.call("decision.plan", { meeting: REVIEW.id, action });
        expect(plan.entry?.decided).toEqual([]);
        const applied = await client.call("decision.apply", { meeting: REVIEW.id, action, onDecided: "refuse" });
        expect(new MeetingStore(store.storage).read(REVIEW.id)!.items.find((item) => item.id === "i2")).toEqual({
            ...before,
            question: action.text,
        });
        expect(
            (await client.call("meeting.rows", { meeting: REVIEW.id })).rows.find((row) => row.id === "i2")?.parts
        ).toContainEqual({ kind: "asks", pieces: [{ text: action.text }] });
        const conflict = await failure(client.call("decision.apply", { meeting: REVIEW.id, action }));
        expect(conflict.message).toContain("wording changed");
        await client.call("decision.revert", { meeting: REVIEW.id, token: applied.entry!.token });
        expect(new MeetingStore(store.storage).read(REVIEW.id)!.items.find((item) => item.id === "i2")).toEqual(before);
    });

    test("a spelling plan lists source occurrences and its selected reach survives both adapters", async () => {
        const { client, store } = await ADAPTERS[kind]();
        await store.update(REVIEW.id, { command: "test", change: "selective spelling" }, (record) => {
            record.items.push({
                id: "i2",
                kind: "term",
                status: "suggested",
                heard: "the",
                proposed: "THIS",
                atSec: 2,
                evidence: { transcriptLine: 0 },
                rules: [],
                suggestedAt: "2026-11-03T09:47:00.000Z",
            });
        });
        const planned = await client.call("decision.plan", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i2"] },
        });
        expect(planned.reach.spelling).toMatchObject({
            dictionary: true,
            occurrences: [
                { line: 0, selected: true, primary: true },
                { line: 1, selected: true, primary: false },
            ],
        });
        const reach = { lines: [{ atSec: 9, line: 1 }], dictionary: false };
        const applied = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i2"], reach },
        });
        expect(new MeetingStore(store.storage).read(REVIEW.id)?.items.find((item) => item.id === "i2")).toMatchObject({
            reach,
        });
        const transcript = await client.call("meeting.transcript", { ref: REVIEW.id, dictionary: false });
        expect(transcript.entries.map((line) => line.text)).toEqual([
            "Let us start with the checkout.",
            "THIS button moved to THIS right.",
        ]);
        const restricted = await client.call("decision.plan", {
            meeting: REVIEW.id,
            action: {
                kind: "confirm",
                items: ["i2"],
                reach: { lines: [{ atSec: 2, line: 0 }], dictionary: false },
            },
        });
        expect(restricted.reach.spelling?.occurrences).toHaveLength(2);
        await client.call("decision.revert", { meeting: REVIEW.id, token: applied.entry!.token });
        expect(
            new MeetingStore(store.storage).read(REVIEW.id)?.items.find((item) => item.id === "i2")
        ).not.toHaveProperty("reach");
    });

    test("decision.apply returns every changed row, including settled and excluded look-alike choices", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const at = "2026-11-03T09:47:00.000Z";
        await store.update(REVIEW.id, { command: "test", change: "word questions" }, (record) => {
            record.items = meetingRecordSchema.parse({
                ...record,
                items: [
                    ...[50, 70].map((atSec, index) => ({
                        id: `i${index + 1}`,
                        kind: "term",
                        status: "suggested",
                        heard: "Ada",
                        proposed: "ADA",
                        atSec,
                        rules: [],
                        suggestedAt: at,
                    })),
                    ...[50, 70, 90, 110].map((fromSec, index) => ({
                        id: `i${index + 3}`,
                        kind: "question",
                        status: "suggested",
                        about: "term",
                        heard: "Ada",
                        fromSec,
                        toSec: fromSec + 4,
                        question: "Which word?",
                        choices: ["ADA"],
                        decides: index < 2 ? [`i${index + 1}`] : [],
                        priority: index === 3 ? 0.1 : 0.9,
                        rules: [],
                        suggestedAt: at,
                    })),
                ],
            }).items;
        });
        const before = await client.call("meeting.rows", { meeting: REVIEW.id, lowPriority: "show" });
        const applied = await client.call("decision.apply", {
            meeting: REVIEW.id,
            lowPriority: "show",
            action: { kind: "answer", question: "i3", answer: "ADO", except: ["i5", "i6"] },
        });
        const after = await client.call("meeting.rows", { meeting: REVIEW.id, lowPriority: "show" });
        const patch = applied.rows!;
        expect(applied.entry?.settled).toEqual(["i4"]);
        expect(patch.changes.map((change) => change.id).sort()).toEqual(["i1", "i2", "i3", "i4", "i5", "i6"]);
        for (const change of patch.changes) {
            expect(change.before).toEqual(before.rows.find((row) => row.id === change.id));
            expect(change.after).toEqual(after.rows.find((row) => row.id === change.id));
        }
        expect(patch.order).toEqual(after.rows.map((row) => row.id));
        expect(patch.hidden).toEqual({ before: before.hidden, after: after.hidden });
        expect(patch.changes.find((change) => change.id === "i5")?.after).toMatchObject({
            status: "suggested",
            choices: expect.arrayContaining([expect.objectContaining({ value: "ADO", role: "earlier" })]),
        });
        const reopened = new MeetingStore(store.storage);
        expect(reopened.read(REVIEW.id)?.items.find((item) => item.id === "i4")?.status).toBe("confirmed");
        expect(reopened.read(REVIEW.id)?.items.find((item) => item.id === "i5")?.status).toBe("suggested");
    });

    test("a decision patch carries hidden rows becoming visible and leaves unchanged rows out", async () => {
        const { client, store } = await ADAPTERS[kind]();
        await store.update(REVIEW.id, { command: "test", change: "low question" }, (record) => {
            record.items = meetingRecordSchema.parse({
                ...record,
                items: [
                    ...record.items,
                    {
                        id: "i2",
                        kind: "question",
                        status: "suggested",
                        about: "speaker",
                        fromSec: 12,
                        toSec: 30,
                        question: "Who speaks?",
                        choices: ["Alex Example"],
                        decides: ["i1"],
                        priority: 0.1,
                        rules: [],
                        suggestedAt: "2026-11-03T09:47:00.000Z",
                    },
                ],
            }).items;
        });
        const result = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "answer", question: "i2", answer: "Alex Example" },
        });
        expect(result.rows?.hidden).toEqual({
            before: { lowPriority: 1, minPriority: 0.5 },
            after: { lowPriority: 0, minPriority: 0.5 },
        });
        expect(result.rows?.changes.find((change) => change.id === "i2")).toMatchObject({
            after: { status: "confirmed" },
        });
        expect(result.rows?.changes.find((change) => change.id === "i2")?.before).toBeUndefined();
        const unchanged = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i1"] },
        });
        expect(unchanged.entry).toBeUndefined();
        expect(unchanged.rows).toBeUndefined();
    });

    test("decision.plan answers the entry and its reach and writes nothing", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const before = store.read(REVIEW.id);
        const planned = await client.call("decision.plan", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i1"] },
        });

        expect(planned.entry?.decided).toEqual(["i1"]);
        expect(planned.reach).toEqual({ items: [], dictionary: [] });
        expect(store.read(REVIEW.id)).toEqual(before);
        expect((await client.call("journal.read", { meeting: REVIEW.id })).entries).toEqual([]);
    });

    test("decision.plan of an answer lists a target outside the asked span with its own quote, value and time", async () => {
        const { client, store } = await ADAPTERS[kind]();
        await store.update(REVIEW.id, { command: "test", change: "a question" }, (record) => {
            record.items.push(
                {
                    kind: "speaker-range",
                    label: "Speaker 2",
                    fromSec: 0,
                    toSec: 20,
                    candidates: ["Alex Example", "Dana Example"],
                    id: "i2",
                    status: "suggested",
                    rules: [],
                    suggestedAt: "2026-11-03T09:47:00.000Z",
                },
                {
                    kind: "question",
                    about: "speaker",
                    fromSec: 25,
                    toSec: 30,
                    question: "Who speaks under Speaker 2?",
                    choices: ["Alex Example", "Dana Example"],
                    decides: ["i2"],
                    id: "i3",
                    status: "suggested",
                    rules: [],
                    suggestedAt: "2026-11-03T09:47:00.000Z",
                }
            );
        });
        const planned = await client.call("decision.plan", {
            meeting: REVIEW.id,
            action: { kind: "answer", question: "i3", answer: "Alex Example" },
        });
        const [target] = planned.reach.items;

        expect(planned.reach.items).toHaveLength(1);
        expect(target).toMatchObject({ id: "i2", role: "sets", before: "Speaker 2", after: "Alex Example" });
        // Its own voice only: Dana's line in the same span is not its evidence.
        expect(target?.row?.parts).toContainEqual({ kind: "said", text: "The button moved to the right." });
        expect(target?.row?.parts).toContainEqual(
            expect.objectContaining({ kind: "when", target: { kind: "item", id: "i2" } })
        );
    });

    test("onDecided refuse: an item decided since is refused with already-decided and the entry that decided it", async () => {
        const { client } = await ADAPTERS[kind](agentHello);
        const first = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i1"] },
        });
        const again = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i1"] },
        });
        const refused = await failure(
            client.call("decision.apply", {
                meeting: REVIEW.id,
                action: { kind: "reject", items: ["i1"] },
                onDecided: "refuse",
            })
        );

        expect(again).toEqual({ skipped: [{ id: "i1", reason: "it is confirmed already", needs: "nothing" }] });
        expect(refused).toBeInstanceOf(MeetingsServiceError);
        expect(refused).toMatchObject({ code: "already-decided" });
        expect(refused.message).toBe(
            "i1 is confirmed already by an agent (Claude Code, session 11111111); nothing was decided"
        );
        expect((refused as MeetingsServiceError).data).toMatchObject({
            code: "already-decided",
            items: ["i1"],
            entry: { token: first.entry!.token },
        });
    });

    test("Wave E: the Moment service preserves an explicit request for no tone", async () => {
        const { client } = await ADAPTERS[kind]();
        const params = { meeting: REVIEW.id, target: { kind: "item" as const, id: "i1" }, tone: false };
        const planned = await client.call("moment.plan", params);
        expect(planned.moment?.tone).toBeUndefined();
        const clipped = await client.call("moment.clip", params);
        expect(clipped.tone).toBeUndefined();
    });

    test("saving a clip keeps audio in the meeting and concurrent repeats share one Context entry", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const params = {
            meeting: REVIEW.id,
            target: { kind: "range" as const, fromSec: 2, toSec: 4 },
            padSec: 0,
            padAfterSec: 0,
            tone: false,
            screen: false,
        };
        const cached = await client.call("moment.clip", params);
        const bytes = await Bun.file(cached.path).arrayBuffer();
        const saved = await Promise.all(
            [1, 2].map(() => client.call("moment.save", { ...params, quote: "The selected words" }))
        );
        expect(saved[0]!.entry.id).toBe(saved[1]!.entry.id);
        expect(saved.filter((result) => result.created)).toHaveLength(1);
        expect(saved[0]!.entry).toMatchObject({
            kind: "file",
            ref: saved[0]!.clip.path,
            note: "The selected words",
            title: "Clip 00:02–00:04",
        });
        expect(saved[0]!.clip.path).toStartWith(`${store.folder(REVIEW.id)}/clips/`);
        expect(await Bun.file(saved[0]!.clip.path).arrayBuffer()).toEqual(bytes);
        const reopened = new MeetingStore(store.storage).read(REVIEW.id)!;
        expect(reopened.context).toEqual([saved[0]!.entry]);
        expect(reopened.history.filter((entry) => entry.command === "clip save")).toHaveLength(1);
        const { unlink } = await import("node:fs/promises");
        await unlink(cached.path);
        expect(await Bun.file(saved[0]!.clip.path).arrayBuffer()).toEqual(bytes);
    });

    test("a failed Context write removes only its newly copied clip", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const params = {
            meeting: REVIEW.id,
            target: { kind: "range" as const, fromSec: 6, toSec: 7 },
            padSec: 0,
            padAfterSec: 0,
            tone: false,
            screen: false,
        };
        const cached = await client.call("moment.clip", params);
        const { basename } = await import("node:path");
        const artifact = join(store.folder(REVIEW.id), "clips", basename(cached.path));
        const update = store.update;
        store.update = async () => {
            throw new Error("simulated Context write failure");
        };
        try {
            expect((await failure(client.call("moment.save", params))).message).toContain(
                "simulated Context write failure"
            );
            expect(await Bun.file(artifact).exists()).toBe(false);
            expect(await Bun.file(cached.path).exists()).toBe(true);
            expect(new MeetingStore(store.storage).read(REVIEW.id)!.context).toEqual([]);
        } finally {
            store.update = update;
        }
    });

    test("a save canceled while waiting for the record lock leaves no artifact or Context entry", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const clip = await client.call("moment.clip", {
            meeting: REVIEW.id,
            target: { kind: "range", fromSec: 5, toSec: 6 },
        });
        const controller = new AbortController();
        const update = store.update;
        store.update = async (...args) => {
            controller.abort();
            return update.apply(store, args);
        };
        try {
            await expect(
                persistClip({ store, record: store.read(REVIEW.id)!, clip, signal: controller.signal })
            ).rejects.toThrow();
            const { basename } = await import("node:path");
            expect(await Bun.file(join(store.folder(REVIEW.id), "clips", basename(clip.path))).exists()).toBe(false);
            expect(new MeetingStore(store.storage).read(REVIEW.id)!.context).toEqual([]);
        } finally {
            store.update = update;
        }
    });

    test("moment.plan answers the Moment, or the target's refusal; moment.clip cuts it into the cache once", async () => {
        const { client } = await ADAPTERS[kind]();
        const missing = await client.call("moment.plan", { meeting: REVIEW.id, target: { kind: "item", id: "i9" } });
        const planned = await client.call("moment.plan", { meeting: REVIEW.id, target: { kind: "item", id: "i1" } });
        const progress: number[] = [];
        // A time of each adapter's own: the two adapters share the sandbox home's clip cache.
        const target = { kind: "time" as const, atSec: kind === "socket" ? 2 : 3 };
        const cut = await client.call(
            "moment.clip",
            { meeting: REVIEW.id, target },
            { onProgress: (update) => progress.push(update.fraction ?? -1) }
        );
        const again = await client.call("moment.clip", { meeting: REVIEW.id, target });
        const plannedCut = await client.call("moment.plan", { meeting: REVIEW.id, target });

        expect(missing).toEqual({ cannot: { code: "unknown-item", message: `No item i9 in ${REVIEW.id}.` } });
        expect(planned.cannot).toBeUndefined();
        expect(planned.moment).toMatchObject({ meeting: REVIEW.id, label: "i1", fromSec: 12, spotSec: 12 });
        expect(again.path).toBe(cut.path);
        expect(cut.path).toContain("meetings-cache/moments/");
        expect({ ...cut, path: "" }).toEqual({ ...plannedCut.moment!, path: "" });
        expect(progress).toEqual([0.5]);
        expect(await client.call("meeting.audio", { meeting: REVIEW.id })).toEqual({
            path: RECORDING,
            tracks: 1,
            channels: 2,
            durationSec: 45,
        });
        const tone = await client.call("tone.preview", { sound: { hz: 440, sec: 0.2, volume: 0.5 } });
        expect(tone.sound).toEqual({ hz: 440, sec: 0.2, volume: 0.5 });
        expect(tone.path).toContain("meetings-cache/tones/tone-");
        const none = await failure(client.call("meeting.audio", { meeting: RETRO.id }));
        expect(none).toMatchObject({ code: "unplayable", data: { code: "unplayable", reason: "no-audio" } });
    });

    test("a receiver reads comments explicitly; only unread comments can be withdrawn", async () => {
        const { client, store } = await ADAPTERS[kind](agentHello);
        MeetingComments.of(store, REVIEW.id).stage({
            target: { kind: "time", atSec: 2 },
            text: "Read this",
            actor: { kind: "window" },
        });
        await client.call("comment.stage", {
            meeting: REVIEW.id,
            target: { kind: "time", atSec: 3 },
            text: "Withdraw this",
        });
        await client.call("comment.send", { meeting: REVIEW.id });
        expect(await failure(client.call("comment.read", { meeting: REVIEW.id, id: "c2" }))).toMatchObject({
            code: "wrong-actor",
        });
        const read = await client.call("comment.read", { meeting: REVIEW.id, id: "c1" });
        expect(read.readAt).toBe(NOW.toISOString());
        expect(await failure(client.call("comment.withdraw", { meeting: REVIEW.id, id: "c1" }))).toMatchObject({
            code: "wrong-actor",
        });
        const withdrawn = await client.call("comment.withdraw", { meeting: REVIEW.id, id: "c2" });
        expect(withdrawn.withdrawnAt).toBe(NOW.toISOString());
        expect(await failure(client.call("comment.read", { meeting: REVIEW.id, id: "c2" }))).toMatchObject({
            code: "withdrawn-comment",
        });
        expect(MeetingComments.of(store, REVIEW.id).list()).toMatchObject([
            { id: "c1", readAt: NOW.toISOString() },
            { id: "c2", withdrawnAt: NOW.toISOString() },
        ]);
    });

    test("comments: staged until sent, sent to the listeners with a journal entry and comment.sent, and never taken back", async () => {
        const { client, store } = await ADAPTERS[kind](agentHello);
        const heard: MeetingsEventMessage[] = [];
        await client.subscribe({ meeting: REVIEW.id, events: ["comment.sent"] }, (event) => heard.push(event));
        const selection = { kind: "selection" as const, from: { atSec: 2, line: 0 }, to: { atSec: 9, line: 1 } };
        const staged = await client.call("comment.stage", {
            meeting: REVIEW.id,
            target: selection,
            text: "The button is the checkout button",
            quote: "The button moved",
        });
        await client.call("comment.stage", { meeting: REVIEW.id, target: { kind: "time", atSec: 4 }, text: "Drop it" });
        const unstaged = await client.call("comment.unstage", { meeting: REVIEW.id, id: "c2" });
        expect(await client.call("comment.send", { meeting: REVIEW.id, requireListener: true })).toEqual({
            sent: [],
            listeners: [],
        });
        expect(MeetingComments.of(store, REVIEW.id).list()[0]?.state).toBe("staged");
        MeetingComments.of(store, REVIEW.id, { now: () => NOW }).join({ pid: LISTENER_PID, actor: { kind: "listen" } });
        const listed = await client.call("comment.list", { meeting: REVIEW.id });
        const sent = await client.call("comment.send", { meeting: REVIEW.id, reason: "for the next round" });
        const nothing = await client.call("comment.send", { meeting: REVIEW.id });

        const agent = { kind: "agent" as const, harness: "claude-code", session: agentHello.session ?? null };
        const listener = { pid: LISTENER_PID, at: NOW.toISOString(), actor: { kind: "listen" as const } };
        expect(staged).toEqual({
            id: "c1",
            at: NOW.toISOString(),
            target: selection,
            text: "The button is the checkout button",
            quote: "The button moved",
            actor: agent,
            state: "staged",
        });
        expect(unstaged).toMatchObject({ id: "c2", text: "Drop it", state: "staged" });
        expect(listed.comments.map((comment) => comment.id)).toEqual(["c1"]);
        expect(listed.listeners).toEqual([listener]);
        expect(sent.sent).toEqual([{ ...staged, state: "sent", sentAt: NOW.toISOString(), token: sent.entry!.token }]);
        expect(sent.listeners).toEqual([listener]);
        expect(sent.entry).toMatchObject({
            actor: agent,
            reason: "for the next round",
            action: {
                kind: "comment",
                comments: [{ id: "c1", target: selection, text: staged.text, quote: staged.quote }],
            },
            changes: [],
        });
        expect(nothing).toEqual({ sent: [], listeners: [listener] });
        expect(heard).toEqual([
            {
                method: "comment.sent",
                params: { meeting: REVIEW.id, token: sent.entry!.token, comments: sent.sent, listeners: [listener] },
            },
        ]);
        expect((await client.call("journal.read", { meeting: REVIEW.id })).entries[0]?.action.kind).toBe("comment");
        const again = await failure(client.call("comment.unstage", { meeting: REVIEW.id, id: "c1" }));
        expect(again).toMatchObject({ code: "already-sent" });
        const unknown = await failure(client.call("comment.send", { meeting: REVIEW.id, ids: ["c7"] }));
        expect(unknown).toMatchObject({ code: "unknown-comment" });
        const undo = await failure(client.call("decision.revert", { meeting: REVIEW.id, token: sent.entry!.token }));
        expect(undo.message).toContain("a sent comment cannot be taken back");
    });

    test("meeting.rows answers the review rows, with the transcript line from the meeting's source", async () => {
        const { client } = await ADAPTERS[kind]();
        const rows = await client.call("meeting.rows", { meeting: REVIEW.id });

        expect(rows.meeting).toBe(REVIEW.id);
        expect(rows.hidden).toEqual({ lowPriority: 0, minPriority: 0.5 });
        expect(rows.rows.map((row) => [row.label, row.edit, row.needs])).toEqual([["i1", "person", undefined]]);
        expect(rows.rows[0]?.parts).toEqual([
            { kind: "who", text: "Speaker 3 → Alex Example" },
            {
                kind: "when",
                from: { sec: 12, text: "00:12" },
                to: { sec: 30, text: "00:30" },
                target: { kind: "item", id: "i1" },
            },
        ]);
        expect(rows.rows[0]?.rules).toEqual(["presence"]);

        expect(rows.rows[0]?.choices.map((choice) => [choice.role, choice.value, choice.confidence])).toEqual([
            ["suggested", "Alex Example", 0.82],
            ["candidate", "Dana Example", undefined],
            ["none", "none of these", undefined],
        ]);
        // No line starts in 0:12 to 0:30, so the row says no words; its source is the line it falls in.
        expect(rows.rows[0]?.sources).toEqual([
            { kind: "line", at: { sec: 9, text: "00:09" }, text: "The button moved to the right." },
        ]);
    });

    test("Clip 5s: a Moment of a selection with lengthSec ends that long after the selection's start", async () => {
        const { client } = await ADAPTERS[kind]();
        const selection = { kind: "selection" as const, from: { atSec: 2, line: 0 }, to: { atSec: 9, line: 1 } };
        const whole = await client.call("moment.plan", { meeting: REVIEW.id, target: selection, padSec: 0 });
        const clip = await client.call("moment.plan", {
            meeting: REVIEW.id,
            target: selection,
            padSec: 0,
            lengthSec: 5,
        });

        expect(whole.moment).toMatchObject({ fromSec: 2 });
        expect(whole.moment!.toSec).toBeGreaterThan(7);
        expect(clip.moment).toMatchObject({ fromSec: 2, toSec: 7, startSec: 2, endSec: 7 });
    });

    test("config version 5: the pads before and after, and a tone preset for one call (decisions 8 and 9)", async () => {
        const { client } = await ADAPTERS[kind]();
        const range = { kind: "range" as const, fromSec: 10, toSec: 12 };
        const split = await client.call("moment.plan", {
            meeting: REVIEW.id,
            target: range,
            padSec: 1,
            padAfterSec: 3,
        });
        const soft = await client.call("moment.plan", {
            meeting: REVIEW.id,
            target: range,
            toneSound: { preset: "soft" },
        });
        const preview = await client.call("tone.preview", { sound: { preset: "click", volume: 0.2 } });
        const presets = await client.call("tone.presets", {});

        expect(split.moment).toMatchObject({ padSec: 1, padAfterSec: 3, startSec: 9, endSec: 15 });
        expect(soft.moment?.tone?.sound).toEqual({ hz: 523, sec: 0.3, volume: 0.35, preset: "soft" });
        expect(preview.sound).toEqual({ hz: 2000, sec: 0.03, volume: 0.2, preset: "click" });
        expect(presets.presets.slice(0, 3)).toEqual([
            { name: "beep", label: "Beep", kind: "sine", volume: 0.6, hz: 880, sec: 0.15, available: true },
            { name: "soft", label: "Soft", kind: "sine", volume: 0.35, hz: 523, sec: 0.3, available: true },
            { name: "click", label: "Click", kind: "sine", volume: 0.7, hz: 2000, sec: 0.03, available: true },
        ]);
        expect(presets.presets.find((preset) => preset.name === "tink")).toMatchObject({
            kind: "file",
            file: "/System/Library/Sounds/Tink.aiff",
        });
    });

    test("a person's meetings are complete and available through either adapter", async () => {
        const { client } = await ADAPTERS[kind]();
        const history = await client.call("people.meetings", { person: "Alex Example" });
        expect(history.person.name).toBe("Alex Example");
        expect(history.meetings.map((meeting) => meeting.meeting)).toEqual([REVIEW.id]);
        expect(history.meetings[0]?.as).toContain("participant");
        const unknown = await failure(client.call("people.meetings", { person: "Nobody Example" }));
        expect(unknown).toMatchObject({ code: "unknown-person" });
    });

    test("the timeline reads: line ends, speakers, screen, waveform; and the overview", async () => {
        const { client, source } = await ADAPTERS[kind]();
        const transcript = await client.call("meeting.transcript", { ref: REVIEW.id });
        const speakers = await client.call("meeting.speakers", { meeting: REVIEW.id });
        const screen = await client.call("meeting.screen", { meeting: REVIEW.id });
        const waveform = await client.call("meeting.waveform", {
            meeting: REVIEW.id,
            fromSec: 0,
            toSec: 10,
            buckets: 5,
        });
        const overview = await client.call("meetings.overview", { days: 3650 });

        expect(transcript.entries.map((entry) => [entry.startSec, entry.endSec])).toEqual([
            [2, 9],
            [9, expect.any(Number)],
        ]);
        expect(speakers).toMatchObject({ meeting: REVIEW.id, timed: true });
        const load = spyOn(source, "load");
        const facts = await client.call("meeting.speakers", { meeting: REVIEW.id, evidence: true });
        // The statistics and the evidence share one opened meeting: one source load.
        expect(load).toHaveBeenCalledTimes(1);
        load.mockRestore();
        expect(facts.evidence?.lines).toContain("|mic?|e?");
        expect(facts.evidence?.lines.split("\n")).toHaveLength(transcript.entries.length + 1);
        expect(facts.evidence?.summary).toEqual(expect.any(Array));
        expect(speakers.evidence).toBeUndefined();
        expect(speakers.speakers.map((one) => one.label).sort()).toEqual(["Dana Example", "Speaker 2"]);
        expect(screen).toEqual({ meeting: REVIEW.id, recorded: false, displays: [], frames: [] });
        expect(waveform).toEqual({ meeting: REVIEW.id, fromSec: 0, toSec: 10, peaks: [0.25, 0.25, 1, 0.25, 0.25] });
        expect(overview.meetings.map((one) => one.id)).toEqual([RETRO.id, REVIEW.id]);
    });

    test("manual assignment pairs only its meeting and Undo removes only its own source", async () => {
        const { client, store, config } = await ADAPTERS[kind]();
        await config.addProject("Atlas");
        await store.update(RETRO.id, { command: "test", change: "another project meeting" }, (record) => {
            record.project = "Atlas";
            record.participants = [{ name: "Bob Example", from: ["calendar"] }];
        });
        const receipt = await client.call("projects.pairFromMeetings", { project: "Atlas", meeting: REVIEW.id });
        expect(receipt.paired.map((person) => person.name)).toEqual(["Alex Example"]);
        const added = receipt.paired[0];
        if (!added) {
            throw new Error("pairing receipt missing");
        }
        const later = { kind: "calendar" as const, from: "calendar", entryId: "later", at: NOW.toISOString() };
        await config.pairPeople({ project: "Atlas", people: [{ name: added.name }], by: later });
        expect(
            await client.call("projects.unpair", { project: "Atlas", person: { name: added.name }, by: added.by })
        ).toEqual({ removed: [{ name: added.name, project: "Atlas", left: false }] });
        expect((await new MeetingsConfigStore(config.storage).read()).projects.Atlas?.match?.people).toEqual([
            { name: added.name, pairedBy: [later] },
        ]);
        expect(
            (await client.call("projects.meetingPeople", { project: "Atlas" })).map((person) => person.name)
        ).toEqual(["Bob Example"]);
        const moved = await failure(client.call("projects.pairFromMeetings", { project: "Other", meeting: REVIEW.id }));
        expect(moved.message).toContain("no longer has project Other");
        expect(moved).toMatchObject({ code: "project-changed" });
    });

    test("the projects: add, labels, preview, rename, unpair and remove answer what their commands print", async () => {
        const { client, store, config } = await ADAPTERS[kind]();

        expect(await client.call("projects.add", { name: "Atlas" })).toEqual({ name: "Atlas", added: true });
        expect(await client.call("projects.add", { name: "Atlas" })).toEqual({ name: "Atlas", added: false });
        expect((await failure(client.call("projects.add", { name: "-atlas" }))).message).toContain(
            "a project name is letters"
        );
        expect(await client.call("projects.labels", { project: "Atlas", add: ["Checkout", "Billing"] })).toEqual({
            project: "Atlas",
            labels: ["Checkout", "Billing"],
        });
        expect(await client.call("projects.labels", { project: "Atlas", remove: ["billing"] })).toEqual({
            project: "Atlas",
            labels: ["Checkout"],
        });
        expect((await failure(client.call("projects.labels", { project: "Nowhere" }))).message).toContain(
            "No project Nowhere"
        );

        // The saved rules match nothing; a draft title word matches the design review.
        const preview = await client.call("projects.preview", { draft: { Atlas: { titleWords: ["Design"] } } });
        expect(preview.map((row) => [row.id, row.project, row.now, row.draft, row.changed])).toEqual([
            [RETRO.id, undefined, [], [], false],
            [REVIEW.id, "Atlas", [], ["Atlas"], true],
        ]);

        expect(await client.call("projects.rename", { from: "Atlas", to: "Harbor" })).toEqual({
            from: "Atlas",
            to: "Harbor",
            meetings: [REVIEW.id],
        });
        expect(store.resolve(REVIEW.id)?.project).toBe("Harbor");

        await config.pairPeople({
            project: "Harbor",
            people: [{ name: "Alex Example", email: "alex@example.com" }],
            by: { kind: "manual", at: NOW.toISOString() },
        });
        const person = { name: "Alex Example", email: "alex@example.com" };
        expect(await client.call("projects.unpair", { project: "Harbor", person })).toEqual({
            removed: [{ project: "Harbor", name: "Alex Example", email: "alex@example.com", left: true }],
        });
        expect(await client.call("projects.unpair", { project: "Harbor", person })).toEqual({ removed: [] });
        expect(await client.call("projects.unpair", { entry: "cal-entry-1" })).toEqual({ removed: [] });
        expect((await failure(client.call("projects.unpair", { project: "Harbor" }))).message).toContain(
            "Name a calendar entry"
        );

        // The design review has Harbor and names Alex (a participant and a named speaker) and the owner: Alex is offered.
        expect(await client.call("projects.meetingPeople", { project: "Harbor" })).toEqual([
            {
                name: "Alex Example",
                meetings: 1,
                last: { id: REVIEW.id, title: "Design review", start: "2026-11-03T09:00:00.000Z" },
            },
        ]);
        expect((await failure(client.call("projects.meetingPeople", { project: "Nowhere" }))).message).toContain(
            "No project Nowhere"
        );
        const paired = await client.call("projects.pairFromMeetings", { project: "Harbor" });
        expect(paired).toEqual({
            project: "Harbor",
            paired: [
                {
                    name: "Alex Example",
                    by: {
                        kind: "manual",
                        at: NOW.toISOString(),
                        note: "from the meeting “Design review” on 2026-11-03",
                    },
                },
            ],
        });
        expect((await config.read()).projects.Harbor?.match?.people.map((one) => one.name)).toEqual(["Alex Example"]);
        expect(await client.call("projects.meetingPeople", { project: "Harbor" })).toEqual([]);
        expect(await client.call("projects.unpair", { project: "Harbor", person: { name: "Alex Example" } })).toEqual({
            removed: [{ project: "Harbor", name: "Alex Example", left: true }],
        });

        const suggestions = await client.call("projects.suggestions", {});
        expect(suggestions.folders.wisprflow).toEqual({ values: ["Design", "Ops"], from: "source" });
        expect(suggestions.calendars).toEqual({ values: ["Home", "Work"] });
        expect(suggestions.labels).toEqual(["Checkout"]);
        expect(suggestions.titleWords).toEqual(["Design", "Retro", "review"]);

        expect((await failure(client.call("projects.remove", { name: "Harbor" }))).message).toContain(
            `1 meeting has the project Harbor: ${REVIEW.id}`
        );
        const removal = await client.call("projects.remove", { name: "Harbor", unassign: true });
        expect(removal).toMatchObject({ name: "Harbor", unassigned: [REVIEW.id] });
        expect(SafeJSON.parse(await Bun.file(removal.backup).text(), { strict: true })).toMatchObject({
            project: "Harbor",
            block: { labels: ["Checkout"] },
        });
        expect(store.resolve(REVIEW.id)?.project).toBeUndefined();
        expect(Object.keys((await config.read()).projects)).toEqual([]);

        // The notice's Undo: the block and the meeting it left without a project come back, once.
        expect(await client.call("projects.restore", { backup: removal.backup })).toMatchObject({
            name: "Harbor",
            meetings: [REVIEW.id],
        });
        expect(store.resolve(REVIEW.id)?.project).toBe("Harbor");
        expect((await config.read()).projects.Harbor?.labels).toEqual(["Checkout"]);
        expect((await failure(client.call("projects.restore", { backup: removal.backup }))).message).toContain(
            "exists again"
        );
    });

    test("the dictionary: add, show, test, a refused Undo's add, a rename and remove", async () => {
        const { client, config } = await ADAPTERS[kind]();
        const fix = { type: "fix" as const, value: "Atlass", substitution: "Atlas" };

        // A new project and its entry are one write: an entry the config refuses adds no project either.
        const badAbbr = { type: "abbr" as const, value: "MOP", substitution: "MOPsuffix" };
        expect(
            (await failure(client.call("dictionary.add", { entry: badAbbr, project: "Fresh", replace: "Gone" })))
                .message
        ).toContain('must contain "MOP" itself');
        expect((await failure(client.call("dictionary.add", { entry: badAbbr, project: "Fresh" }))).message).toContain(
            'must contain "MOP" itself'
        );
        expect(Object.keys((await config.read()).projects)).toEqual([]);

        expect(await client.call("dictionary.add", { entry: fix })).toEqual({
            entry: fix,
            level: "global",
            projectAdded: false,
        });
        const term = { type: "term" as const, value: "Harbor", spoken: ["harbour"] };
        expect(await client.call("dictionary.add", { entry: term, project: "Atlas" })).toEqual({
            entry: term,
            level: "project Atlas",
            projectAdded: true,
        });

        const refused = await failure(client.call("dictionary.add", { entry: fix, ifAbsent: true }));
        expect(refused).toBeInstanceOf(MeetingsConflictError);
        expect(errorText(refused)).toBe(
            "[dictionary-exists] Atlass is in the global dictionary already; it was left as it is"
        );

        const shown = await client.call("dictionary.show", { project: "Atlas" });
        expect(shown.project).toBe("Atlas");
        expect(shown.entries.map((entry) => [entry.value, entry.level])).toEqual([
            ["Atlass", "global"],
            ["Harbor", "project Atlas"],
        ]);
        expect((await client.call("dictionary.show", {})).entries.map((entry) => entry.value)).toEqual(["Atlass"]);
        expect((await failure(client.call("dictionary.show", { project: "Nowhere" }))).message).toContain(
            "Unknown project Nowhere"
        );

        const tested = await client.call("dictionary.test", { phrase: "The Atlass page in harbour", project: "Atlas" });
        expect(tested.text).toBe("The Atlas page in Harbor");
        expect(tested.fired.map((entry) => entry.value)).toEqual(["Atlass", "Harbor"]);

        const renamed = { ...fix, value: "Atlasss" };
        expect(await client.call("dictionary.add", { entry: renamed, replace: "Atlass" })).toEqual({
            entry: renamed,
            level: "global",
            projectAdded: false,
            replaced: "Atlass",
        });
        expect((await client.call("dictionary.show", {})).entries.map((entry) => entry.value)).toEqual(["Atlasss"]);

        expect(await client.call("dictionary.remove", { value: "Atlasss" })).toEqual({
            value: "Atlasss",
            level: "global",
            removed: true,
        });
        expect(await client.call("dictionary.remove", { value: "Atlasss" })).toEqual({
            value: "Atlasss",
            level: "global",
            removed: false,
        });
    });

    test("config.edit writes every change in one write, or none when one names a value changed since", async () => {
        const { client, config } = await ADAPTERS[kind]();

        expect(
            await client.call("config.edit", {
                edits: [
                    { path: "global.capture.activeFps", value: 2 },
                    { path: "global.assign.ask", value: false, expect: true },
                ],
            })
        ).toEqual([
            { path: ["global", "capture", "activeFps"], value: 2 },
            { path: ["global", "assign", "ask"], value: false },
        ]);

        const stale = await failure(
            client.call("config.edit", {
                edits: [
                    { path: "global.capture.activeFps", value: 3 },
                    { path: "global.assign.ask", unset: true, expect: true },
                ],
            })
        );
        expect(stale).toBeInstanceOf(MeetingsConflictError);
        expect(errorText(stale)).toStartWith("[config-stale] global.assign.ask changed since it was read");
        expect((await config.read()).global.capture.activeFps).toBe(2);
    });

    test("a subscription with an empty meeting is refused as invalid params instead of hearing every meeting", async () => {
        const { client } = await ADAPTERS[kind]();
        const refused = await failure(client.subscribe({ meeting: "" }, () => undefined));

        expect(refused).toMatchObject({ code: -32602 });
        expect(refused.message).toStartWith("subscribe: meeting:");
    });
});

test("an unreadable config omits the row patch without blocking a decision", async () => {
    const { store, linkedSource } = scratchStore();
    const client = new InProcessMeetingsClient({
        hello,
        deps: {
            ...quietDeps,
            store: () => store,
            linkedSource,
            config: async () => {
                throw new Error("fixture config unreadable");
            },
        },
    });
    try {
        const result = await client.call("decision.apply", {
            meeting: REVIEW.id,
            action: { kind: "confirm", items: ["i1"] },
        });
        expect(result.entry?.decided).toEqual(["i1"]);
        expect(result.rows).toBeUndefined();
        expect(new MeetingStore(store.storage).read(REVIEW.id)?.items[0]?.status).toBe("confirmed");
    } finally {
        client.close();
    }
});

test("the last listener's stop leaves the connection subscribed to nothing, not to every event", async () => {
    const { service } = await startService();
    const sent = spyOn(RpcSocketClient.prototype, "call");
    let unsubscribe: unknown;

    try {
        const client = await SocketMeetingsClient.connect(service.entry, hello);
        closing.push(() => client.close());
        const stop = await client.subscribe({ meeting: REVIEW.id, events: ["meeting.changed"] }, () => {});
        stop();
        // The socket answers in order: the stop's unsubscribe went out before this call.
        await client.call("meetings.list", { limit: 1 });
        unsubscribe = sent.mock.calls.filter(([method]) => method === UNSUBSCRIBE).at(-1)?.[1];
    } finally {
        sent.mockRestore();
    }

    expect(unsubscribe).toEqual({});

    // What unsubscribe hears on the wire, beside what the old empty subscription heard.
    const heard = async (stop: boolean): Promise<number> => {
        const raw = await RpcSocketClient.connect({
            socket: service.entry.socket,
            logScope: "test",
            label: "test",
        });
        closing.push(() => raw.close());
        let count = 0;
        raw.onNotification(() => {
            count += 1;
        });
        await raw.call("hello", hello);
        await raw.call("subscribe", { events: [] });
        if (stop) {
            await raw.call(UNSUBSCRIBE, {});
        }
        service.emit("meeting.changed", { meeting: RETRO.id, parts: ["show"] });
        await raw.call("meetings.list", { limit: 1 });
        return count;
    };

    expect(await heard(false)).toBe(1);
    expect(await heard(true)).toBe(0);
});

describe("the Meetings service's connections", () => {
    test("hello records who the caller is; another protocol or another checkout's code is refused", async () => {
        const { service } = await startService();
        const agent = await SocketMeetingsClient.connect(service.entry, {
            role: "agent",
            harness: "claude-code",
            session: "11111111-2222-4333-8444-555555555555",
            protocol: MEETINGS_PROTOCOL,
            code: CODE,
        });
        closing.push(() => agent.close());

        expect(service.callers()).toEqual([
            { role: "agent", harness: "claude-code", session: "11111111-2222-4333-8444-555555555555" },
        ]);
        const otherProtocol = await failure(
            SocketMeetingsClient.connect(service.entry, { ...hello, protocol: MEETINGS_PROTOCOL + 1 })
        );
        expect(otherProtocol.message).toBe(`the meetings service speaks protocol 1, not ${MEETINGS_PROTOCOL + 1}`);
        const otherCode = await failure(
            SocketMeetingsClient.connect(service.entry, { ...hello, code: "ffffffffffff" })
        );
        expect(otherCode.message).toBe(`the meetings service runs the code of another checkout (${CODE})`);
    });

    test("a subscription before hello is refused without registering it", async () => {
        const { service } = await startService();
        const raw = await rawConnection(service.entry.socket);
        const early = await raw.request(SUBSCRIBE, { events: ["meeting.changed"] });
        expect(early.reply.error).toMatchObject({ data: { code: "no-hello" } });
        service.emit("meeting.changed", { meeting: REVIEW.id, parts: ["show"] });
        await raw.request("hello", { role: "window", protocol: MEETINGS_PROTOCOL });
        expect(raw.lines.filter((line) => line.method === "meeting.changed")).toEqual([]);
    });

    test("the service refuses a meeting filter that does not read, and after unsubscribe a connection hears nothing", async () => {
        const { service } = await startService();
        const raw = await rawConnection(service.entry.socket);
        await raw.request("hello", { role: "window", protocol: MEETINGS_PROTOCOL });
        await raw.request(SUBSCRIBE, { meeting: REVIEW.id, events: ["meeting.changed"] });
        const refused = await raw.request(SUBSCRIBE, { meeting: 42 });
        service.emit("meeting.changed", { meeting: RETRO.id, parts: ["show"] });
        service.emit("meeting.changed", { meeting: REVIEW.id, parts: ["show"] });
        await raw.request(UNSUBSCRIBE, {});
        service.emit("meeting.changed", { meeting: REVIEW.id, parts: ["transcript"] });
        await raw.request("meetings.list", { limit: 1 });

        expect(refused.reply.error).toMatchObject({ code: -32602 });
        expect(raw.lines.filter((line) => line.method === "meeting.changed")).toEqual([
            { jsonrpc: "2.0", method: "meeting.changed", params: { meeting: REVIEW.id, parts: ["show"] } },
        ]);
    });

    test("a second start in the folder answers the running service", async () => {
        const { dir, service } = await startService();
        const second = await startMeetingsService({ dir, idleMs: 0, code: CODE, rivalWaitMs: 500, watch: false });

        expect(second).toMatchObject({ status: "running", entry: { pid: service.entry.pid, code: CODE } });
    });

    test("the people book invalidates Contacts even on a meeting-scoped subscription", async () => {
        const folder = fakeFolderEvents();
        const { service, store } = await startService({ watch: { subscribe: folder.subscribe, coalesceMs: 0 } });
        const client = await SocketMeetingsClient.connect(service.entry, hello);
        closing.push(() => client.close());
        const heard = eventQueue();
        await client.subscribe({ meeting: REVIEW.id, events: ["people.changed"] }, heard.push);
        folder.raise(join(store.root, "people.json"));
        expect(await heard.next()).toEqual({ method: "people.changed", params: {} });
    });

    test("folder watch accepts canonical and aliased paths beneath the hidden data root", async () => {
        const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mtg-watch-")));
        const actualRoot = join(scratch, ".genesis-tools", "meetings");
        mkdirSync(join(actualRoot, "fixture"), { recursive: true });
        const root = join(scratch, "linked-meetings");
        symlinkSync(actualRoot, root, "dir");
        const source = fakeFolderEvents();
        const heard = eventQueue();
        const watcher = new MeetingsFolderWatch({
            root,
            emit: () => {},
            commentsChanged: (meeting) => heard.push({ method: "comment.changed", params: { meeting } }),
            subscribe: source.subscribe,
            coalesceMs: 0,
        });
        await watcher.start();
        try {
            for (const eventRoot of [actualRoot, root]) {
                source.raise(join(eventRoot, "fixture", "comments.ndjson"));
                expect(await heard.next()).toEqual({ method: "comment.changed", params: { meeting: "fixture" } });
            }
            source.raise(join(scratch, "outside", "comments.ndjson"));
            expect(heard.left()).toEqual([]);
        } finally {
            await watcher.stop();
        }
    });

    test("folder watch makes a missing meetings root, so writes that come later are heard without a restart", async () => {
        const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mtg-watch-missing-")));
        const root = join(scratch, "not-yet", "meetings");
        const source = fakeFolderEvents();
        const heard = eventQueue();
        const watcher = new MeetingsFolderWatch({
            root,
            emit: () => {},
            commentsChanged: (meeting) => heard.push({ method: "comment.changed", params: { meeting } }),
            subscribe: source.subscribe,
            coalesceMs: 0,
        });
        await watcher.start();
        try {
            expect(existsSync(root)).toBe(true);
            source.raise(join(root, "fixture", "comments.ndjson"));
            expect(await heard.next()).toEqual({ method: "comment.changed", params: { meeting: "fixture" } });
        } finally {
            await watcher.stop();
        }
    });

    test("a tone preview is published only after it is made, so a failed run is made again by the next preview", async () => {
        const sound = { hz: 431, sec: 0.27, volume: 0.31 };
        const made: string[] = [];
        const failing: MeetingsHandlerDeps = {
            ...quietDeps,
            tone: async (_sound, path) => {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, "RI");
                throw new Error("ffmpeg stopped halfway");
            },
        };
        const working: MeetingsHandlerDeps = {
            ...quietDeps,
            tone: async (_sound, path) => {
                made.push(path);
                writeFileSync(path, "RIFF");
            },
        };

        await expect(previewTone({ sound }, failing)).rejects.toThrow("ffmpeg stopped halfway");
        const preview = await previewTone({ sound }, working);

        expect(made).toHaveLength(1);
        expect(made[0]).not.toBe(preview.path);
        expect(existsSync(made[0]!)).toBe(false);
        expect(readFileSync(preview.path, "utf8")).toBe("RIFF");
    });

    test("listener journal changes refresh the meeting's comment receiver state", async () => {
        const folder = fakeFolderEvents();
        const { service, store } = await startService({ watch: { subscribe: folder.subscribe, coalesceMs: 0 } });
        const client = await SocketMeetingsClient.connect(service.entry, hello);
        closing.push(() => client.close());
        const heard = eventQueue();
        await client.subscribe({ meeting: REVIEW.id, events: ["comment.changed"] }, heard.push);
        folder.raise(join(store.folder(REVIEW.id), "comments.ndjson"));
        expect(await heard.next()).toEqual({ method: "comment.changed", params: { meeting: REVIEW.id } });
    });

    test("the folder watch tells meeting.changed for a write outside the service, once per meeting and burst, and never for its own decisions, clips or journal lines", async () => {
        const folder = fakeFolderEvents();
        const { service, store } = await startService({ watch: { subscribe: folder.subscribe, coalesceMs: 0 } });
        const client = await SocketMeetingsClient.connect(service.entry, hello);
        closing.push(() => client.close());
        const heard = eventQueue();
        await client.subscribe({ events: ["meeting.changed", "decision.applied"] }, heard.push);
        const file = (meeting: string, ...path: string[]) => join(store.folder(meeting), ...path);
        const handEdit = (meeting: string) =>
            writeFileSync(file(meeting, MEETING_FILE), `${SafeJSON.stringify(store.read(meeting), null, 4)}\n`);
        const every = ["show", "transcript", "speakers", "timeline"];

        // A hand edit of the record and the recorder's OCR line in one burst: one event, every part.
        handEdit(REVIEW.id);
        folder.raise(file(REVIEW.id, MEETING_FILE), file(REVIEW.id, "ocr.jsonl"));
        expect(await heard.next()).toEqual({ method: "meeting.changed", params: { meeting: REVIEW.id, parts: every } });
        // A frame changes the timeline; a clip in an old moments folder, the journal and the energy change nothing.
        folder.raise(
            file(RETRO.id, "moments", "clip.wav"),
            file(RETRO.id, "decisions.ndjson"),
            file(RETRO.id, "evidence", "energy.bin"),
            file(REVIEW.id, "frames", "0001.png")
        );
        expect(await heard.next()).toEqual({
            method: "meeting.changed",
            params: { meeting: REVIEW.id, parts: ["timeline"] },
        });
        // The service's own decision tells decision.applied, and its record write no meeting.changed.
        await client.call("decision.apply", { meeting: REVIEW.id, action: { kind: "confirm", items: ["i1"] } });
        expect(await heard.next()).toMatchObject({ method: "decision.applied", params: { meeting: REVIEW.id } });
        // Its record write raised with another meeting's frame: only the frame tells.
        folder.raise(file(REVIEW.id, MEETING_FILE), file(RETRO.id, "frames", "0001.png"));
        expect(await heard.next()).toEqual({
            method: "meeting.changed",
            params: { meeting: RETRO.id, parts: ["timeline"] },
        });
        await client.call("moment.save", { meeting: REVIEW.id, target: { kind: "range", fromSec: 2, toSec: 4 } });
        expect(await heard.next()).toEqual({
            method: "meeting.changed",
            params: { meeting: REVIEW.id, parts: ["show"] },
        });
        folder.raise(file(REVIEW.id, MEETING_FILE), file(RETRO.id, "frames", "0002.png"));
        expect(await heard.next()).toEqual({
            method: "meeting.changed",
            params: { meeting: RETRO.id, parts: ["timeline"] },
        });
        // A hand edit after it is outside again.
        handEdit(REVIEW.id);
        folder.raise(file(REVIEW.id, MEETING_FILE));
        expect(await heard.next()).toEqual({ method: "meeting.changed", params: { meeting: REVIEW.id, parts: every } });
        await client.call("meetings.list", { limit: 1 });

        expect(heard.left()).toEqual([]);
    });

    test("openMeetingsClient answers in-process with no service, and for a service of another checkout", async () => {
        const none = await openMeetingsClient({ dir: serviceDir() });
        closing.push(() => none.close());
        expect(none.kind).toBe("in-process");

        // The tests' service names CODE; this process's own code stamp is the checkout's, so it is another code.
        const { dir } = await startService();
        const other = await openMeetingsClient({ dir });
        closing.push(() => other.close());
        expect(other.kind).toBe("in-process");
    });

    test("openMeetingsClient connects to a service of this checkout's code", async () => {
        const { store, linkedSource } = scratchStore();
        const dir = serviceDir();
        const start = await startMeetingsService({ dir, store: () => store, linkedSource, idleMs: 0, watch: false });

        if (start.status !== "started") {
            throw new Error("the meetings service did not start");
        }

        closing.push(() => start.service.stop("test end"));
        const client = await openMeetingsClient({ dir });
        closing.push(() => client.close());

        expect(client.kind).toBe("socket");
        expect((await client.call("meetings.list", { limit: 1 })).map((row) => row.id)).toEqual([RETRO.id]);
        expect(start.service.callers().map((caller) => caller.role)).toEqual(["cli"]);
    });

    // The mid-use invariant: a service that runs old code (a module it loaded changed since it started) refuses every
    // new caller, and a command answers in its own process with its own code.
    test("a service whose code changed since its start refuses a hello, and a command answers in-process", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "mtg-code-")));
        const loaded = join(root, "loaded.ts");
        writeFileSync(loaded, "export const loaded = 1;\n");
        await import(loaded);
        const { store, linkedSource } = scratchStore();
        const dir = serviceDir();
        const start = await startMeetingsService({
            dir,
            store: () => store,
            linkedSource,
            idleMs: 0,
            sourceRoot: root,
            watch: false,
        });

        if (start.status !== "started") {
            throw new Error("the meetings service did not start");
        }

        closing.push(() => start.service.stop("test end"));
        const before = await openMeetingsClient({ dir });
        closing.push(() => before.close());
        expect(before.kind).toBe("socket");

        const later = new Date(Date.now() + 60_000);
        utimesSync(loaded, later, later);
        const refused = await failure(
            SocketMeetingsClient.connect(start.service.entry, { ...hello, code: meetingsCodeStamp() })
        );
        expect(refused.message).toBe("the meetings service's code changed since it started; it exits soon");
        const after = await openMeetingsClient({ dir });
        closing.push(() => after.close());
        expect(after.kind).toBe("in-process");
        // The caller connected before the change keeps its connection until the service exits.
        expect((await before.call("meetings.list", { limit: 1 })).map((row) => row.id)).toEqual([RETRO.id]);
    });

    test("a read whose service went during the call answers in-process", async () => {
        const { store, linkedSource } = scratchStore();
        const dir = serviceDir();
        const start = await startMeetingsService({ dir, store: () => store, linkedSource, idleMs: 0, watch: false });

        if (start.status !== "started") {
            throw new Error("the meetings service did not start");
        }

        const client = await openMeetingsClient({ dir });
        closing.push(() => client.close());
        start.service.stop("test: gone");
        await start.service.stopped;

        // The fallback reads this process's store: the sandbox home's, which holds no meeting of the scratch store.
        expect(await client.call("meetings.list", { project: "Atlas" })).toEqual([]);
    });
});

/** One message on a raw socket line, as the Swift client sees it. */
type Line = Record<string, unknown>;

/** A raw connection: send a request and wait for the reply of its id; notifications are kept in order. */
async function rawConnection(socket: string) {
    const lines: Line[] = [];
    const waiters: Array<() => void> = [];
    let pending = "";
    const connection = await Bun.connect({
        unix: socket,
        socket: {
            data: (_socket, chunk) => {
                pending += new TextDecoder().decode(chunk);
                let end = pending.indexOf("\n");

                while (end >= 0) {
                    lines.push(SafeJSON.parse(pending.slice(0, end), { strict: true }) as Line);
                    pending = pending.slice(end + 1);
                    end = pending.indexOf("\n");
                }

                for (const wake of waiters.splice(0)) {
                    wake();
                }
            },
        },
    });
    closing.push(() => connection.end());
    let nextId = 1;

    return {
        lines,
        async request(method: string, params: unknown): Promise<{ request: Line; reply: Line }> {
            const request = { jsonrpc: "2.0", id: nextId++, method, params };
            connection.write(`${SafeJSON.stringify(request, { strict: true })}\n`);

            for (;;) {
                const reply = lines.find((line) => line.id === request.id);

                if (reply) {
                    return { request, reply };
                }

                await new Promise<void>((resolve) => waiters.push(resolve));
            }
        },
    };
}

interface Example {
    method: string;
    direction: string;
    note?: string;
    request?: Line;
    reply?: Line;
    notification?: Line;
}

/** Every example of the fixture, from a live service on a scratch store over raw sockets. */
async function captureExamples(): Promise<Example[]> {
    const timingRoot = mkdtempSync(join(tmpdir(), "mtg-protocol-words-"));
    const model = join(timingRoot, "model.onnx");
    writeFileSync(model, "fixture-model");
    const modelFiles = [wordTimingFile(model)];
    const { service, store, config } = await startService({
        deps: {
            freeCores: async () => ({ performanceCores: 12, idleCores: 2.6 }),
            voiceFrames: async () => FIXTURE_VOICE_FRAMES,
            wordTimings: {
                cache: new WordTimingCache(join(timingRoot, "cache")),
                modelFiles: async () => modelFiles,
                infer: async () => ({
                    words: [{ text: "Let", startSec: 2.1, endSec: 2.4 }],
                    pcmSha256: "fixture-pcm",
                    modelFiles,
                }),
            },
        },
    });
    const examples: Example[] = [];
    const ask = async (
        connection: Awaited<ReturnType<typeof rawConnection>>,
        method: string,
        params: unknown,
        note?: string
    ) => {
        const { request, reply } = await connection.request(method, params);
        examples.push({
            method,
            direction: "client→service",
            ...(note ? { note } : {}),
            request,
            reply,
        });
    };

    const window = await rawConnection(service.entry.socket);
    await ask(window, "hello", { role: "window", protocol: MEETINGS_PROTOCOL }, "The window sends no code.");
    await ask(window, "meetings.list", {});
    await ask(window, "meetings.list", { project: "Atlas", full: true }, "full: the whole records.");
    await ask(window, "meeting.show", { ref: REVIEW.id });
    await ask(window, "meeting.people.edit", { meeting: "nope", action: "add", name: "Dana Example" });
    await ask(window, "meeting.voice", { meeting: "nope" });
    await ask(window, "meeting.suggest", { meeting: "nope" });
    await ask(window, "meeting.listen.prepare", { meeting: "nope", group: "spot-check" });
    await ask(window, "meeting.voice.enrol", { meeting: "nope" });
    await ask(
        window,
        "voices.list",
        { project: "Atlas" },
        "A project with no voice samples still lists its attended people, each with an empty samples array."
    );
    await ask(window, "voices.preview", { meeting: "nope" });
    await ask(window, "voices.apply", { meeting: "nope" });
    await ask(window, "voices.sample", { project: "Atlas", person: "Alice Example", sample: 0 });
    await ask(window, "voices.workers", {}, "What auto voice workers means now, from a fixed CPU sample.");
    await ask(
        window,
        "voices.remove",
        { project: "Atlas", person: "Alice Example", preview: true },
        "preview: read only."
    );
    await ask(window, "meeting.show", { ref: "nope" }, "No meeting: meeting-not-found.");
    await ask(window, "meeting.show", { ref: "2026-11-03" }, "A prefix of two meetings: meeting-ref.");
    await ask(window, "meeting.transcript", { ref: REVIEW.id });
    await ask(window, "meeting.transcript", {
        ref: REVIEW.id,
        withSuggested: true,
        previewThresholds: [0.5, 0.6, 0.7, 0.8, 0.9, 1],
    });
    await ask(
        window,
        "meeting.transcript",
        { ref: REVIEW.id, withSuggested: true },
        "The native transcript keeps confidence and guess metadata for its local threshold."
    );
    await ask(window, "meeting.wordTimings.generate", {
        ref: REVIEW.id,
        fromSec: 0,
        toSec: 12,
        model: "fixture/words",
    });
    await ask(window, "meeting.transcript", { ref: RETRO.id }, "No transcript source: a meeting state.");
    await ask(
        window,
        "meeting.transcript",
        {
            ref: RETRO.id,
            withSuggested: true,
            previewThresholds: [0.5, 0.6, 0.7, 0.8, 0.9, 1],
        },
        "No transcript source with the combined native threshold preview flags."
    );
    await ask(
        window,
        "meeting.transcript",
        { ref: RETRO.id, withSuggested: true },
        "No transcript source with the native preview flags."
    );
    await ask(window, "meeting.revisions", { ref: REVIEW.id });
    await ask(window, "meetings.list", { limit: 0 }, "A bad param: -32602 before any handler.");
    await ask(window, SUBSCRIBE, { meeting: REVIEW.id, events: ["meeting.changed"] });
    await ask(window, SUBSCRIBE, {
        meeting: REVIEW.id,
        events: ["meeting.changed", "people.changed", "meeting.wordTimings.changed"],
    });
    service.emit("meeting.changed", { meeting: REVIEW.id, parts: ["show", "transcript"] });
    service.emit("people.changed", {});
    service.emit("meeting.wordTimings.changed", { meeting: REVIEW.id, revision: "fixture-revision" });
    await ask(window, "meetings.list", { limit: 1 }, "Sent after the event, so the event is in before its reply.");

    examples.push({
        method: "people.changed",
        direction: "service→client",
        notification: window.lines.find((line) => line.method === "people.changed"),
    });
    examples.push({
        method: "meeting.wordTimings.changed",
        direction: "service→client",
        notification: window.lines.find((line) => line.method === "meeting.wordTimings.changed"),
    });
    const notification = window.lines.find((line) => line.method === "meeting.changed");
    examples.push({
        method: "meeting.changed",
        direction: "service→client",
        ...(notification ? { notification } : {}),
    });
    await ask(
        window,
        SUBSCRIBE,
        { meeting: "" },
        "A meeting filter that does not read: -32602, and the subscription before stays."
    );
    await ask(window, UNSUBSCRIBE, {}, "The end of the subscription: no event reaches it until it subscribes again.");

    const agent = await rawConnection(service.entry.socket);
    await ask(
        agent,
        "hello",
        { ...agentHello, role: "agent" },
        "An agent (the REPL, an MCP door): its decisions name its harness and session."
    );
    await ask(
        window,
        SUBSCRIBE,
        { meeting: REVIEW.id, events: ["decision.applied", "decision.reverted", "comment.sent"] },
        "The window hears every decision on the open meeting, with its journal entry, and each send of its comments."
    );
    await ask(
        agent,
        "decision.plan",
        { meeting: REVIEW.id, action: { kind: "confirm", items: ["i1"] } },
        "What a confirm would do and reach; nothing is written."
    );
    const applied = await agent.request("decision.apply", {
        meeting: REVIEW.id,
        action: { kind: "confirm", items: ["i1"] },
        reason: "the calendar says so",
    });
    examples.push({
        method: "decision.apply",
        direction: "client→service",
        note: "The actor comes from the connection's hello; the reason is kept on the entry and the item.",
        ...applied,
    });
    const { token } = z.object({ entry: z.object({ token: z.string() }) }).parse(applied.reply.result).entry;
    await ask(
        agent,
        "decision.revert",
        { meeting: REVIEW.id, token },
        "The Undo of one entry, whole; items: [...] undoes only those."
    );
    await ask(agent, "decision.apply", { meeting: REVIEW.id, action: { kind: "confirm", items: ["i1"] } });
    await ask(
        window,
        "decision.apply",
        { meeting: REVIEW.id, action: { kind: "reject", items: ["i1"] }, onDecided: "refuse" },
        "The window's click on an item decided since: already-decided, with the entry that decided it."
    );
    await ask(window, "journal.read", { meeting: REVIEW.id, limit: 2 }, "Newest first; revertedBy names the Undo.");
    await ask(
        window,
        "moment.plan",
        { meeting: REVIEW.id, target: { kind: "item", id: "i1" } },
        "The Moment of a row: its span, pad, asked spot (spotSec) and tone (tone.atSec)."
    );
    await ask(
        window,
        "moment.plan",
        { meeting: REVIEW.id, target: { kind: "item", id: "i9" } },
        "A target the meeting does not have: cannot, and no Moment."
    );
    await ask(
        window,
        "moment.clip",
        { meeting: REVIEW.id, target: { kind: "time", atSec: 9 } },
        "Cut into the clip cache."
    );

    await ask(window, "meeting.audio", { meeting: REVIEW.id }, "One track: the window plays the file itself.");
    await ask(
        window,
        "acoustic.inspect",
        { meeting: "missing", fromSec: 0, toSec: 5 },
        "Missing meeting never manufactures acoustic evidence."
    );
    await ask(
        window,
        "acoustic.clip",
        { meeting: "missing", fromSec: 0, toSec: 5 },
        "Missing recording never creates tracks."
    );
    await ask(
        window,
        "voice.score",
        { meeting: "missing", fromSec: 0, toSec: 5, channel: 1 },
        "Missing recording never names a voice."
    );
    await ask(window, "voice.enroll", {
        meeting: "missing",
        fromSec: 0,
        toSec: 5,
        channel: 1,
        person: "Alice Example",
        confirmed: true,
    });
    await ask(
        window,
        "voice.prepare",
        { download: false },
        "Model provisioning requires an explicit download action, no model is fetched by this fixture."
    );
    await ask(window, "voice.collect", { meeting: "missing" });
    await ask(window, "acoustic.collect", { meeting: "missing" });
    await ask(
        window,
        "meeting.audio",
        { meeting: RETRO.id },
        "No source keeps the recording: unplayable with reason no-audio."
    );
    await ask(
        window,
        "tone.preview",
        { sound: { hz: 880, sec: 0.15, volume: 0.6 } },
        "The tone alone, for a Play button."
    );
    await ask(
        window,
        "tone.preview",
        { sound: { preset: "click" } },
        "A named tone without a volume: its own volume; the answer is its sine and names the preset."
    );
    await ask(
        window,
        "moment.plan",
        {
            meeting: REVIEW.id,
            target: { kind: "range", fromSec: 10, toSec: 12 },
            padSec: 1,
            padAfterSec: 3,
            toneSound: { preset: "soft" },
        },
        "Two pads and a tone for this call: padAfterSec shows where it differs from padSec; the tone names its preset."
    );
    await ask(
        window,
        "tone.presets",
        {},
        "The sound picker's named tones: three sines and the Mac's alert sounds; available is false where this Mac lacks the file."
    );
    await ask(window, "meeting.speakers", { meeting: REVIEW.id }, "Talk time per label, its spans, and the hints.");
    await ask(window, "meeting.screen", { meeting: REVIEW.id }, "No screen recording: no frames, no pane.");
    await ask(window, "meeting.timeline", { meeting: REVIEW.id }, "No screen recording: a useful read failure.");
    const frameFolder = store.folder(RETRO.id);
    mkdirSync(join(frameFolder, "frames"), { recursive: true });
    // A one-pixel PNG is enough to verify the image metadata and pixel-box contract.
    writeFileSync(
        join(frameFolder, "frames/screen.png"),
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP/0AAAAASUVORK5CYII=",
            "base64"
        )
    );
    writeFileSync(
        join(frameFolder, "ocr.jsonl"),
        `${SafeJSON.stringify({
            file: "frames/screen.png",
            at: RETRO.start,
            displayId: 1,
            text: "Agenda",
            blocks: [{ text: "Agenda", confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
        })}\n`
    );
    await ask(
        window,
        "meeting.timeline",
        { meeting: RETRO.id, frame: "frames/screen.png" },
        "A frame with all OCR boxes."
    );
    await ask(
        window,
        "meeting.waveform",
        { meeting: REVIEW.id, fromSec: 0, toSec: 10, buckets: 5 },
        "Peaks for the strip, 0 to 1 of the loudest 100 ms."
    );
    await ask(window, "meetings.overview", { days: 3650 }, "The meetings with what each waits for.");
    await ask(window, "config.read", { path: "global.playback.listen.longestClipSec" });
    await ask(window, "sourceAudio.plan", {}, "Read-only reconciliation with isolated empty local catalogs.");
    await ask(
        window,
        "sourceAudio.apply",
        { plan: { version: 1, meetingsRoot: store.root, entries: [] } },
        "Explicit apply of an empty plan."
    );
    await ask(window, "config.set", { path: "global.playback.listen.longestClipSec", value: 25 });
    await ask(window, "config.unset", { path: "global.playback.listen.longestClipSec" }, "Back to its default.");
    await ask(window, "meeting.rows", { meeting: REVIEW.id }, "The review rows, in the order listen asks.");
    const selection = { kind: "selection", from: { atSec: 2, line: 0 }, to: { atSec: 9, line: 1 } };
    await ask(
        window,
        "moment.plan",
        { meeting: REVIEW.id, target: selection, lengthSec: 5 },
        "Clip 5s: the selection's Moment, 5 s from its start."
    );
    await ask(
        window,
        "comment.stage",
        { meeting: REVIEW.id, target: selection, text: "The button is the checkout button", quote: "The button moved" },
        "A comment on the selected words, for the listening agent."
    );
    await ask(window, "comment.stage", { meeting: REVIEW.id, target: { kind: "time", atSec: 4 }, text: "Drop it" });
    await ask(window, "comment.unstage", { meeting: REVIEW.id, id: "c2" }, "Taken back before it was sent.");
    MeetingComments.of(store, REVIEW.id, { now: () => NOW }).join({ pid: LISTENER_PID, actor: { kind: "listen" } });
    await ask(window, "comment.list", { meeting: REVIEW.id }, "Who listens now: a send names them, or keeps them.");
    await ask(window, "comment.send", { meeting: REVIEW.id }, "Every staged comment; the journal keeps the entry.");
    await ask(window, "comment.unstage", { meeting: REVIEW.id, id: "c1" }, "A sent comment: already-sent.");
    await ask(window, "comment.send", { meeting: REVIEW.id, ids: ["c7"] }, "No such comment: unknown-comment.");
    await ask(window, SUBSCRIBE, { meeting: REVIEW.id, events: ["comment.changed"] });
    await ask(
        window,
        "comment.read",
        { meeting: REVIEW.id, id: "c1" },
        "The author cannot acknowledge its own comment: wrong-actor."
    );
    await ask(agent, "comment.read", { meeting: REVIEW.id, id: "c1" }, "A receiver acknowledges the first comment.");
    await ask(window, "comment.withdraw", { meeting: REVIEW.id, id: "c1" }, "An acknowledged comment: already-read.");
    await ask(window, "comment.stage", { meeting: REVIEW.id, target: selection, text: "Withdraw before reading" });
    await ask(window, "comment.send", { meeting: REVIEW.id, ids: ["c3"] });
    await ask(window, "comment.withdraw", { meeting: REVIEW.id, id: "c3" });
    await ask(window, "comment.read", { meeting: REVIEW.id, id: "c3" }, "The withdrawal won: withdrawn-comment.");
    await ask(window, "comment.list", { meeting: REVIEW.id }, "Read receipts and withdrawals survive reopening.");
    examples.push({
        method: "comment.changed",
        direction: "service→client",
        notification: window.lines.find((line) => line.method === "comment.changed"),
    });
    await ask(
        window,
        "people.known",
        { query: "ex", meeting: REVIEW.id, atSec: 9 },
        "The person picker's list: ranked for the meeting and the moment, with each source's state; nothing preselected."
    );
    await ask(window, "people.meetings", { person: "Alex Example" }, "All meetings where this person appears.");
    await ask(
        window,
        "people.add",
        { name: "Robin Example", email: "robin@example.com", note: "from the board" },
        "The picker's Add 'Robin Example' as new speaker: a person in the people book."
    );
    await ask(
        window,
        "people.hide",
        { person: "robin@example.com" },
        "Left out of every list; hidden: false shows them."
    );
    await ask(window, "people.hide", { person: "Nobody Example" }, "Nobody known by that name: unknown-person.");
    await ask(
        window,
        "people.planMerge",
        { a: "Alex Example", b: "robin@example.com" },
        "What a merge links (meetings, renamed labels); nothing is written and no meeting record changes on a merge."
    );
    const merged = await window.request("people.merge", { a: "Alex Example", b: "robin@example.com" });
    examples.push({
        method: "people.merge",
        direction: "client→service",
        note: "An alias in the people book; its token splits it again.",
        ...merged,
    });
    const mergeToken = z.object({ merge: z.object({ token: z.string() }) }).parse(merged.reply.result).merge.token;
    await ask(window, "people.unmerge", { token: mergeToken }, "The merge split again.");
    await ask(window, "people.unmerge", { token: "nope" }, "No merge has that token: unknown-merge.");
    await ask(window, "people.add", { name: "Robin Example", email: "robin.two@example.com" }, "A second Robin.");
    await ask(
        window,
        "people.hide",
        { person: "Robin Example" },
        "A name two people share: ambiguous-person, with the candidates to pick from."
    );
    await ask(
        window,
        "decision.plan",
        { meeting: REVIEW.id, action: { kind: "assign", person: "Dana Example", lines: [{ atSec: 9, line: 1 }] } },
        "One line given to a person: the assignment, and the stretches of the same label it may also reach."
    );
    await ask(
        window,
        "projects.add",
        { name: "Atlas" },
        "The settings page's Add project; added: false when it was known."
    );
    await ask(
        window,
        "projects.labels",
        { project: "Atlas", add: ["Checkout"] },
        "remove takes labels away the same way."
    );
    await ask(
        window,
        "config.edit",
        {
            edits: [
                { path: '["sources","wisprflow","match","Atlas","folders"]', value: ["Design"] },
                { path: '["projects","Atlas","match","title","words"]', value: ["review"], expect: null },
            ],
        },
        "The page's Save rules: a project's source folders and title words in one write; expect names the value read."
    );
    await ask(
        window,
        "projects.preview",
        { draft: { Atlas: { titleWords: ["Retro"] } }, limit: 5 },
        "Each recent meeting against the saved rules (now) and the draft being edited."
    );
    await ask(
        window,
        "dictionary.add",
        { entry: { type: "fix", value: "Atlass", substitution: "Atlas" }, project: "Atlas" },
        "An entry in the project's dictionary."
    );
    await ask(
        window,
        "dictionary.add",
        { entry: { type: "fix", value: "Atlass", substitution: "Atlas" }, project: "Atlas", ifAbsent: true },
        "An Undo's add of an entry made again since: dictionary-exists, and it is left as it is."
    );
    await ask(
        window,
        "dictionary.show",
        { project: "Atlas" },
        "The global entries, then the project's, each with its level."
    );
    await ask(window, "dictionary.test", { phrase: "The Atlass page", project: "Atlas" });
    await ask(
        window,
        "dictionary.remove",
        { value: "Atlass", project: "Atlas" },
        "removed: false when it was not there."
    );
    await config.pairPeople({
        project: "Atlas",
        people: [{ name: "Alex Example", email: "alex@example.com" }],
        by: {
            kind: "calendar",
            from: "apple-calendar",
            entryId: "cal-2041",
            at: NOW.toISOString(),
            title: "Design review",
        },
    });
    await ask(
        window,
        "projects.unpair",
        { entry: "cal-2041" },
        "The pairings one calendar entry made; left: the person is no longer paired with the project."
    );
    await ask(
        window,
        "projects.unpair",
        { project: "Atlas", person: { name: "Alex Example", email: "alex@example.com" } },
        "One person from one project: nothing when they were not paired."
    );
    await ask(
        window,
        "projects.suggestions",
        {},
        "The values the rule fields offer: each source's folders, the Calendar app's calendars, words and labels in use."
    );
    await ask(
        window,
        "projects.meetingPeople",
        { project: "Atlas" },
        "The people of the project's meetings not paired with it yet."
    );
    await ask(
        window,
        "projects.pairFromMeetings",
        { project: "Atlas", people: [{ name: "Alex Example" }] },
        "Pair one of them; a person not on a calendar entry is paired by hand, with the meeting in the note."
    );
    await ask(window, "projects.rename", { from: "Atlas", to: "Harbor" }, "Its settings, pairings and meetings.");
    await ask(
        window,
        "projects.remove",
        { name: "Harbor" },
        "Refused while a meeting has it; unassign leaves the meeting without a project."
    );
    await ask(window, "projects.remove", { name: "Harbor", unassign: true }, "The backup keeps the removed settings.");
    for (const method of ["decision.applied", "decision.reverted", "comment.sent"]) {
        const heard = window.lines.find((line) => line.method === method);
        examples.push({ method, direction: "service→client", ...(heard ? { notification: heard } : {}) });
    }

    const cli = await rawConnection(service.entry.socket);
    await ask(
        cli,
        "hello",
        {
            role: "cli",
            harness: "claude-code",
            session: "11111111-2222-4333-8444-555555555555",
            protocol: 1,
            code: CODE,
        },
        "A CLI in an agent session: the harness and session come from whoIsCalling."
    );
    const early = await rawConnection(service.entry.socket);
    await ask(early, "meeting.show", { ref: REVIEW.id }, "A call before hello: no-hello.");
    await ask(early, "hello", { role: "cli", protocol: 2, code: CODE }, "Another protocol: protocol-mismatch.");
    await ask(
        early,
        "hello",
        { role: "cli", protocol: 1, code: "ffffffffffff" },
        "Another checkout's code: code-mismatch; the CLI answers in its own process."
    );
    await ask(
        window,
        "moment.save",
        { meeting: REVIEW.id, target: { kind: "range", fromSec: 2, toSec: 4 }, quote: "Saved words" },
        "Keep audio outside the temporary clip cache and publish its Context entry."
    );
    // Successes last, so the record they change is read by no example before them.
    await ask(
        window,
        "meeting.voice",
        { meeting: REVIEW.id },
        "Each line's features per channel; a silent channel has no pitch."
    );
    await ask(
        window,
        "meeting.voice",
        { meeting: REVIEW.id, voices: 2 },
        "Voices asked: each line also carries its cluster, with a speaker only when a confirmed line anchors it."
    );
    await ask(
        window,
        "acoustic.inspect",
        { meeting: REVIEW.id, fromSec: 0, toSec: 5 },
        "No calibrated channels: unknown, with the reason and no metric."
    );
    await ask(
        window,
        "voice.score",
        { meeting: REVIEW.id, fromSec: 0, toSec: 1, channel: 0 },
        "A sample under 1.5 seconds is an unknown voice, not a refusal."
    );
    await ask(
        window,
        "meeting.people.edit",
        { meeting: REVIEW.id, action: "add", name: "Robin Example", fromSec: 0, toSec: 30 },
        "The record with the person and the stay."
    );
    await ask(
        window,
        "meeting.people.edit",
        { meeting: REVIEW.id, action: "remove", name: "Robin Example" },
        "The record without the person."
    );
    const removal = examples.findLast((example) => example.method === "projects.remove" && example.reply?.result);
    await ask(
        window,
        "projects.restore",
        { backup: (removal?.reply?.result as { backup?: string } | undefined)?.backup },
        "The Undo of the removal: the block, its pairings and the meeting it left without a project come back."
    );
    await ask(window, "rules.names", {}, "Every rule's sentence by its id, as a review row words an item's rules.");
    await ask(
        window,
        "meeting.sources.near",
        { meeting: REVIEW.id },
        "The source meetings near the record's start, nearest first; this one is linked to the record already."
    );
    await ask(
        window,
        "meeting.link",
        { meeting: RETRO.id, source: "wisprflow:wf-2041" },
        "A source meeting another record holds: refused, so two records never share one source meeting."
    );
    await ask(window, "voice.backfill", { project: "Unassigned-fixture", dryRun: true });
    await store.update(RETRO.id, { command: "fixture", change: "seat transition" }, (record) => {
        record.seats = {
            room: ["Reed Example", { name: "Fern Example", fromSec: 60, toSec: 120 }],
            remote: [{ name: "Fern Example", toSec: 60, label: "Guest" }],
            microphones: [{ id: "self", people: ["Reed Example", "Fern Example"] }],
        };
    });
    await ask(window, "meeting.seats.suggest", { meeting: RETRO.id });
    await ask(window, "meeting.thresholds.preview", { meeting: "nope", values: {} });
    await ask(window, "voices.move", { id: "vs_missing", to: { name: "Reed Example" } });
    await ask(window, "voices.reject", { id: "vs_missing", reason: "bad-audio" });
    await ask(window, "voices.undo", { token: "missing" });
    await ask(window, "voices.quality", { project: "Atlas" });
    return examples;
}

/** Voice frames of the fixture's recording, as ffmpeg would decode them: the left channel speaks low for the first
 * 20 seconds, the right one high after that, and the quiet side has no pitch. One frame is 50 ms. */
const FIXTURE_VOICE_FRAMES = Array.from({ length: 900 }, (_, index) => {
    const voiced = (pitchHz: number) => ({ rms: 0.2, lowBandShare: 0.6, tilt: -4, pitchHz, voicedShare: 1 });
    const quiet = { rms: 0.002, lowBandShare: 0.1, tilt: 0, pitchHz: null, voicedShare: 0 };
    return { channels: index * 0.05 < 20 ? [voiced(120), quiet] : [quiet, voiced(210)] };
});

/** Give volatile values portable stand-ins. References to the same generated ID keep the same stand-in. */
function normalized(examples: Example[]): unknown {
    const aliases = new Map<string, number>();
    const ordinal = (value: string) => {
        const existing = aliases.get(value);
        if (existing !== undefined) {
            return existing;
        }

        const next = aliases.size + 1;
        aliases.set(value, next);
        return next;
    };
    const recordingKey = (key: string) => `fixture${ordinal(`audio:${key}`)}`;
    const now = NOW.toISOString();

    return SafeJSON.parse(
        SafeJSON.stringify(examples, { strict: true })
            .replace(/"meetingsRoot":"[^"]*"/g, '"meetingsRoot":"<meetings>"')
            .replace(/ in \/[^ "]*?\. List them/g, " in <meetings>. List them")
            .replace(
                /"(show|transcript|speakers|timeline)":"([0-9a-z]+)"/g,
                (_, field, key: string) => `"${field}":"fixture${ordinal(`revision:${key}`)}"`
            )
            .replace(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
                (id) => `00000000-0000-4000-8000-${String(ordinal(`uuid:${id}`)).padStart(12, "0")}`
            )
            .replace(
                /"path":"[^"]*?(\/meetings-cache\/[^"]*?)-([0-9a-z]+)\.wav"/g,
                (_, clip, key: string) => `"path":"<home>${clip}-${recordingKey(key)}.wav"`
            )
            .replace(/"path":"[^"]*\/upload\.ogg"/g, '"path":"<recording>/upload.ogg"')
            .replace(/"path":"[^"]*\/meetings\/config\.json"/g, '"path":"<meetings>/config.json"')
            .replace(
                /"(path|ref)":"[^"]*\/(2026-11-03-1000-design-review\/clips\/[^"/]+?)-([0-9a-z]+)\.wav"/g,
                (_, field, clip, key: string) => `"${field}":"<meetings>/${clip}-${recordingKey(key)}.wav"`
            )
            .replace(
                /"backup":"([^"]*\/\d{4}-\d{2}-\d{2}-\d{4}(-project-[^"/]+?)(?:-\d+)?\.json)"/g,
                (_, path: string, project: string) =>
                    `"backup":"<home>/backups/meetings/2026-11-03-1000${project}-${ordinal(`backup:${path}`)}.json"`
            )
            .replace(/"at":"[^"]*","command":/g, `"at":"${now}","command":`)
            .replace(
                /"change":"([^"]*?)-([0-9a-z]+)\.wav"/g,
                (_, change, key: string) => `"change":"${change}-${recordingKey(key)}.wav"`
            )
            .replace(/"generatedAt":"[^"]*"/g, `"generatedAt":"${now}"`)
            .replace(
                /"(cacheRevision|revision|audioFingerprint|modelFingerprint|id)":"([a-f0-9]{64})"/g,
                (_, field, hash: string) => `"${field}":"${ordinal(`hash:${hash}`).toString(16).padStart(64, "0")}"`
            )
            .replace(
                /"(path|folder)":"[^"\n]*\/(2026-11-03-1400-retro(?:\/frames\/screen\.png)?)"/g,
                '"$1":"<meetings>/$2"'
            )
            .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
            // The built-in sounds are host-dependent; keep the fixture's wire type a boolean.
            .replace(/("file":"\/System\/Library\/Sounds\/[^"]+","available":)(?:true|false)/g, "$1true"),
        { strict: true }
    );
}

describe("tools meetings serve --detach", () => {
    test.each([
        [
            ["serve", "--detach", "--no-idle"],
            ["meetings", "serve", "--no-idle"],
        ],
        [
            ["serve", "--detach"],
            ["meetings", "serve"],
        ],
    ])("%p starts %p", async (args, command) => {
        const entry: serviceHost.ServiceEntry = {
            version: 1,
            protocol: 1,
            pid: 1,
            socket: "/fixture.sock",
            startedAt: "2026-11-10T00:00:00.000Z",
            codeStamp: 0,
        };
        const launch = spyOn(serviceHost, "launchService").mockResolvedValue({ status: "running", entry });
        const result = spyOn(out, "result").mockImplementation(() => undefined);

        try {
            const program = new Command().exitOverride();
            registerServeCommand(program);
            await program.parseAsync(args, { from: "user" });

            expect(launch).toHaveBeenCalledTimes(1);
            expect(launch.mock.calls[0][0].command).toEqual(command);
            expect(result).toHaveBeenCalledWith(entry);
        } finally {
            launch.mockRestore();
            result.mockRestore();
        }
    });
});

describe("the protocol fixture (__fixtures__/meetings-protocol.json)", () => {
    test("regeneration preserves which generated tokens belong to each request and reply", () => {
        const examples = (token: string, other: string): Example[] => [
            {
                method: "decision.revert",
                direction: "client→service",
                request: { params: { token } },
                reply: { result: { token: other, action: { token } } },
            },
        ];
        const first = "c5cceaca-9f3c-4dda-afc2-a44408ee72f8";
        const second = "f2c4d1e2-1162-47be-9964-793308a2e1f3";
        const expected = examples("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
        expect(normalized(examples(first, second))).toEqual(expected);
        expect(normalized(examples(second, first))).toEqual(expected);
    });

    test("a live service on the scratch store answers every example as the fixture holds it", async () => {
        const captured = normalized(await captureExamples());

        if (env.test.shouldWriteGolden()) {
            const path = join(import.meta.dir, "__fixtures__/meetings-protocol.json");
            const document = {
                protocol: MEETINGS_PROTOCOL,
                about: "One real request and reply per Meetings service method and event (src/meetings/lib/service/api.ts), captured over raw sockets from the TypeScript service on a scratch store with invented meetings. The Swift client tests decode these, and service.test.ts checks the schemas and the live service. Regenerate with GENESIS_TOOLS_WRITE_GOLDEN=1 bun run test src/meetings/lib/service/service.test.ts --test-name-pattern 'a live service on the scratch store'.",
                examples: captured,
            };
            writeFileSync(path, `${SafeJSON.stringify(document, { strict: true }, 2)}\n`);
        } else {
            expect(captured).toEqual(fixture.examples);
        }
    });

    test("every example fits its method's schemas, and every method, event and refusal code has one", () => {
        const examples = fixture.examples as Example[];

        for (const example of examples) {
            if (example.method === SUBSCRIBE || example.method === UNSUBSCRIBE) {
                const refused = (example.reply?.error as { code?: number } | undefined)?.code === -32602;
                expect(subscribeParamsSchema.safeParse(example.request?.params).success).toBe(!refused);
                expect(subscribeResultSchema.safeParse(example.reply?.result).success).toBe(!refused);
                continue;
            }

            if (example.notification) {
                const schema = NOTIFICATION_SCHEMAS[example.method as keyof typeof NOTIFICATION_SCHEMAS];
                expect({ method: example.method, ok: schema.safeParse(example.notification.params).success }).toEqual({
                    method: example.method,
                    ok: true,
                });
                continue;
            }

            const method = meetingsMethod(example.method as Parameters<typeof meetingsMethod>[0]);
            // The bad-param example is refused by its schema (-32602); every other request fits it.
            const badParam = (example.reply?.error as { code?: number } | undefined)?.code === -32602;
            expect({ method: example.method, ok: method.params.safeParse(example.request?.params).success }).toEqual({
                method: example.method,
                ok: !badParam,
            });

            if (example.reply && "result" in example.reply) {
                const result = method.result.safeParse(example.reply.result);
                expect({ method: example.method, ok: result.success }).toEqual({ method: example.method, ok: true });
            }
        }

        const named = new Set(examples.map((example) => example.method));
        expect(
            [...meetingsApi.methods.map((method) => method.name), SUBSCRIBE, UNSUBSCRIBE, ...MEETINGS_EVENTS].filter(
                (method) => !named.has(method)
            )
        ).toEqual([]);
        const codes = examples.flatMap((example) => {
            const data = example.reply?.error as { data?: { code?: string } } | undefined;
            return data?.data?.code ? [data.data.code] : [];
        });
        expect([...new Set(codes)].sort()).toEqual(
            [
                "already-decided",
                "ambiguous-person",
                "dictionary-exists",
                "project-in-use",
                "failed",
                "unplayable",
                "unknown-comment",
                "already-sent",
                "already-read",
                "withdrawn-comment",
                "wrong-actor",
                "unknown-person",
                "unknown-merge",
                "code-mismatch",
                "meeting-not-found",
                "meeting-ref",
                "no-hello",
                "no-transcript-source",
                "protocol-mismatch",
                "source-linked",
            ].sort()
        );
    });

    test("service.json names the service's protocol and code", async () => {
        const { dir } = await startService();
        const entry = SafeJSON.parse(await Bun.file(serviceEntryPath(dir)).text(), { strict: true });

        expect(entry).toMatchObject({ version: 1, protocol: MEETINGS_PROTOCOL, code: CODE });
    });
});

describe("linking a source meeting from the window", () => {
    test("meeting.sources.near lists the source meetings near a record, and meeting.link links one", async () => {
        const base = fakeSource();
        const meeting = {
            ...(await base.load("wf-2041")),
            sourceMeetingId: "wf-3000",
            title: "Retro call",
            start: "2026-11-03T13:02:00.000Z",
        };
        const source: TranscriptSource = {
            ...base,
            load: async () => meeting,
            describe: () => ({ meetingId: "wf-3000" }),
            evidence: async () => null,
            meetingsBetween: async () => [
                { sourceMeetingId: "wf-3000", title: "Retro call", start: meeting.start, hasTranscript: true },
            ],
        };
        const { service, store } = await startService({ deps: { sources: async () => source } });
        const client = await SocketMeetingsClient.connect(service.entry, hello);
        closing.push(() => client.close());

        expect(await client.call("meeting.sources.near", { meeting: RETRO.id })).toEqual({
            meetings: [
                {
                    ref: "wisprflow:wf-3000",
                    source: "Fake",
                    title: "Retro call",
                    start: "2026-11-03T13:02:00.000Z",
                    hasTranscript: true,
                },
            ],
            unavailable: [],
        });
        const linked = await client.call("meeting.link", { meeting: RETRO.id, source: "wisprflow:wf-3000" });
        expect(linked.id).toBe(RETRO.id);
        expect(store.resolve(RETRO.id)?.sources).toEqual({ wisprflow: { meetingId: "wf-3000" } });
        const refused = await failure(client.call("meeting.link", { meeting: RETRO.id, source: "elsewhere:1" }));
        expect(refused).toMatchObject({ code: "meeting-ref" });
    });
});

describe("explicit word timing generation", () => {
    function setup() {
        const root = mkdtempSync(join(tmpdir(), "mtg-words-"));
        const audioPath = join(root, "audio.wav"),
            model = join(root, "model.onnx");
        writeFileSync(audioPath, "audio");
        writeFileSync(model, "model");
        const input: WordTimingInput = {
            audioPath,
            live: false,
            lines: [{ id: "l1", text: "alpha beta", startSec: 0, endSec: 2 }],
        };
        const cache = new WordTimingCache(join(root, "cache"));
        const modelFiles = [wordTimingFile(model)];
        let calls = 0;
        const deps: WordTimingGenerateDeps = {
            read: async () => input,
            cache,
            modelFiles: async () => modelFiles,
            infer: async () => {
                calls++;
                return { words: [{ text: "alpha", startSec: 0.1, endSec: 0.4 }], pcmSha256: "fake-pcm", modelFiles };
            },
        };
        const options = { meeting: "test-meeting", window: { fromSec: 0, toSec: 2 }, model: "test/words" };
        return {
            input,
            cache,
            deps,
            options,
            modelFiles,
            get calls() {
                return calls;
            },
        };
    }

    test("model provenance follows the runtime cache even when a separate hub copy exists", async () => {
        const root = mkdtempSync(join(tmpdir(), "mtg-model-caches-"));
        const runtime = join(root, "runtime");
        const hub = join(root, "hub", "models--test--words");
        const model = join(runtime, "test", "words");
        mkdirSync(model, { recursive: true });
        mkdirSync(hub, { recursive: true });
        writeFileSync(join(model, "weights.onnx"), "actual");
        writeFileSync(join(hub, "weights.onnx"), "unrelated");
        const files = wordTimingModelFiles(runtime, "test/words");
        expect(files.map((file) => file.path)).toEqual([join(model, "weights.onnx")]);
        expect(() => wordTimingModelFiles(join(root, "missing"), "test/words")).toThrow("not cached");
        const f = setup();
        f.deps.modelFiles = async () => files;
        f.deps.infer = async () => ({ words: [], pcmSha256: "fake-pcm", modelFiles: files });
        await generateWordTimings(f.options, f.deps);
        writeFileSync(join(model, "weights.onnx"), "changed actual");
        expect(f.cache.read(f.input.lines).wordTimings.state).toBe("stale");
    });

    test("generates, reopens and reuses the completed result without more inference", async () => {
        const f = setup();
        const first = await generateWordTimings(f.options, f.deps);
        expect(first.reused).toBe(false);
        expect(first.coverage.matchedWords).toBe(1);
        const reopened = new WordTimingCache(f.cache.folder).read(f.input.lines);
        expect(reopened.entries[0].words?.[0].startSec).toBe(0.1);
        const second = await generateWordTimings(f.options, f.deps);
        expect(second.reused).toBe(true);
        expect(second.cacheRevision).toBe(first.cacheRevision);
        expect(f.calls).toBe(1);
    });

    test("a correction reuses raw evidence but publishes only matches to current text", async () => {
        const f = setup();
        await generateWordTimings(f.options, f.deps);
        f.input.lines[0].text = "different beta";
        const next = await generateWordTimings(f.options, f.deps);
        expect(next.reused).toBe(true);
        expect(next.coverage.matchedWords).toBe(0);
        expect(f.calls).toBe(1);
        expect(f.cache.read(f.input.lines).entries[0].words).toBeUndefined();
    });

    test("one cancelled waiter does not cancel another equal request", async () => {
        const f = setup();
        let started!: () => void, finish!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let calls = 0;
        f.deps.infer = async (_input, signal) => {
            calls++;
            started();
            await gate;
            signal.throwIfAborted();
            return {
                words: [{ text: "alpha", startSec: 0.1, endSec: 0.4 }],
                pcmSha256: "fake-pcm",
                modelFiles: f.modelFiles,
            };
        };
        const abort = new AbortController();
        const first = generateWordTimings({ ...f.options, signal: abort.signal }, f.deps);
        const firstRejected = first.then(
            () => false,
            () => true
        );
        const second = generateWordTimings(f.options, f.deps);
        await entered;
        abort.abort(new Error("cancel first waiter"));
        expect(await firstRejected).toBe(true);
        finish();
        expect((await second).coverage.matchedWords).toBe(1);
        expect(calls).toBe(1);
    });

    test("last waiter cancellation reaches inference and publishes no cache", async () => {
        const f = setup();
        let started!: () => void, killed!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const stopped = new Promise<void>((resolve) => {
            killed = resolve;
        });
        f.deps.infer = async (_input, signal) => {
            started();
            return new Promise((_resolve, reject) =>
                signal.addEventListener(
                    "abort",
                    () => {
                        killed();
                        reject(signal.reason);
                    },
                    { once: true }
                )
            );
        };
        const abort = new AbortController();
        const task = generateWordTimings({ ...f.options, signal: abort.signal }, f.deps);
        const rejected = task.then(
            () => false,
            () => true
        );
        await entered;
        abort.abort(new Error("stop generation"));
        expect(await rejected).toBe(true);
        await stopped;
        expect(f.cache.read(f.input.lines).wordTimings.state).toBe("missing");
    });

    test("an immediate retry gets a fresh job while the cancelled worker is still settling", async () => {
        const f = setup();
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });

        let calls = 0;
        f.deps.infer = async (_input, signal) => {
            calls++;
            if (calls === 1) {
                entered();
                await hold;
                signal.throwIfAborted();
            }
            return {
                words: [{ text: "alpha", startSec: 0.1, endSec: 0.4 }],
                pcmSha256: "fake-pcm",
                modelFiles: f.modelFiles,
            };
        };
        const abort = new AbortController();
        const first = generateWordTimings({ ...f.options, signal: abort.signal }, f.deps).catch(() => undefined);
        await started;
        abort.abort();
        await first;
        const retry = generateWordTimings(f.options, f.deps);
        const outcome = retry.then(
            (value) => ({ value }),
            (error: unknown) => ({ error })
        );
        // Flush the retry's resolved read/model awaits before releasing the old worker.
        await new Promise<void>((resolve) => setImmediate(resolve));
        release();
        const result = await outcome;
        expect(result).toHaveProperty("value.coverage.matchedWords", 1);
        expect(calls).toBe(2);
    });

    test("an immediate retry retires a deadline-expired worker before it settles", async () => {
        const f = setup();
        const deadline = new AbortController();
        const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
        const clock = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
            ms === 120_000 ? deadline.signal : originalTimeout(ms)
        );
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        f.deps.infer = async (_input, signal) => {
            calls++;
            if (calls === 1) {
                entered();
                await hold;
                signal.throwIfAborted();
            }
            return {
                words: [{ text: "alpha", startSec: 0.1, endSec: 0.4 }],
                pcmSha256: "fake-pcm",
                modelFiles: f.modelFiles,
            };
        };
        try {
            const first = generateWordTimings(f.options, f.deps).catch(() => undefined);
            await started;
            deadline.abort(new Error("deadline expired"));
            clock.mockRestore();
            const retry = generateWordTimings(f.options, f.deps);
            const outcome = retry.then(
                (value) => ({ value }),
                (error: unknown) => ({ error })
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
            release();
            await first;
            expect(await outcome).toHaveProperty("value.coverage.matchedWords", 1);
            expect(calls).toBe(2);
        } finally {
            release?.();
            clock.mockRestore();
        }
    });

    test("a changed transcript during inference cannot publish stale timing ranges", async () => {
        const f = setup();
        f.deps.infer = async () => {
            f.input.lines[0].text = "changed";
            return { words: [], pcmSha256: "fake-pcm", modelFiles: f.modelFiles };
        };
        await expect(generateWordTimings(f.options, f.deps)).rejects.toThrow("changed during");
        expect(f.cache.read(f.input.lines).wordTimings.state).toBe("missing");
    });

    test("live recordings refuse generation before loading a model", async () => {
        const f = setup();
        f.input.live = true;
        f.deps.modelFiles = async () => {
            throw new Error("must not load model");
        };
        await expect(generateWordTimings(f.options, f.deps)).rejects.toThrow("Stop the recording");
    });

    test("socket and in-process clients expose the same saved words and emit their own event", async () => {
        const f = setup();
        const wordTimings = {
            cache: f.cache,
            modelFiles: f.deps.modelFiles,
            infer: async () => ({
                words: [{ text: "Let", startSec: 2.1, endSec: 2.4 }],
                pcmSha256: "fake-pcm",
                modelFiles: f.modelFiles,
            }),
        };
        const { service, store } = await startService({ deps: { wordTimings } });
        const socket = await SocketMeetingsClient.connect(service.entry, hello);
        closing.push(() => socket.close());
        const linked = fakeSource();
        const direct = new InProcessMeetingsClient({
            hello,
            deps: {
                store: () => store,
                linkedSource: () => ({ source: linked, sourceMeetingId: "wf-2041" }),
                ...quietDeps,
                wordTimings,
            },
        });
        closing.push(() => direct.close());
        const events = eventQueue();
        await socket.subscribe({ meeting: REVIEW.id, events: ["meeting.wordTimings.changed"] }, events.push);
        const generated = await socket.call("meeting.wordTimings.generate", {
            ref: REVIEW.id,
            fromSec: 0,
            toSec: 12,
            model: "test/words",
        });
        expect(generated.coverage.matchedWords).toBe(1);
        expect((await events.next()).method).toBe("meeting.wordTimings.changed");
        const fromSocket = await socket.call("meeting.transcript", { ref: REVIEW.id });
        const fromDirect = await direct.call("meeting.transcript", { ref: REVIEW.id });
        expect(fromSocket).toEqual(fromDirect);
        expect(fromSocket.entries[0].words?.[0].range).toEqual({ location: 0, length: 3 });
    });

    test("generation reads the preserved audio after the source removed its file", async () => {
        const f = setup();
        const read: string[] = [];
        const wordTimings = {
            cache: f.cache,
            modelFiles: f.deps.modelFiles,
            infer: async (input: { audioPath: string }) => {
                read.push(input.audioPath);
                return {
                    words: [{ text: "Let", startSec: 2.1, endSec: 2.4 }],
                    pcmSha256: "fake-pcm",
                    modelFiles: f.modelFiles,
                };
            },
        };
        const { store } = await startService({ deps: { wordTimings } });
        const owned = join(store.folder(REVIEW.id), "source-audio", `${"b".repeat(64)}.ogg`);
        mkdirSync(dirname(owned), { recursive: true });
        writeFileSync(owned, "owned");
        await store.update(REVIEW.id, { command: "test", change: "preserved" }, (next) => {
            next.audio = {
                sources: {
                    wisprflow: {
                        sourceMeetingId: "wf-2041",
                        path: owned,
                        sha256: "b".repeat(64),
                        bytes: 5,
                        savedAt: "2026-11-05T14:10:00.000Z",
                    },
                },
            };
        });
        const removed: TranscriptSource = {
            ...fakeSource(),
            evidence: async () => ({ segments: [], speaking: [], files: [] }),
        };
        const direct = new InProcessMeetingsClient({
            hello,
            deps: {
                store: () => store,
                linkedSource: () => ({ source: removed, sourceMeetingId: "wf-2041" }),
                ...quietDeps,
                wordTimings,
            },
        });
        closing.push(() => direct.close());

        await direct.call("meeting.wordTimings.generate", {
            ref: REVIEW.id,
            fromSec: 0,
            toSec: 12,
            model: "test/words",
        });
        expect(read).toEqual([owned]);
    });
});
