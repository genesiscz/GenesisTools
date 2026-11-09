import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsStateError } from "@genesiscz/utils/meetings/conflict";
import { MEETING_FILE, MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { serviceEntryPath } from "@genesiscz/utils/rpc/service-host";
import { Storage } from "@genesiscz/utils/storage/storage";
import { z } from "zod";
import { errorText } from "../shared";
import type { LinkedSource } from "../sources";
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
} from "./api";
import {
    InProcessMeetingsClient,
    LocalMeetingsEvents,
    type MeetingsClient,
    type MeetingsEventMessage,
    openMeetingsClient,
    SocketMeetingsClient,
} from "./client";
import { type MeetingsHandlerDeps, MeetingsServiceError } from "./handlers";
import { startMeetingsService } from "./service";

/** The code stamp of the tests' service and callers, so the fixture's hello does not name a checkout's path. */
const CODE = "0123456789ab";

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
        meetingFolders: async () => [],
        folderWrite: { supported: false, reason: "fake", manualStep: "none" },
    };
}

let stores = 0;

/** A scratch store with the two meetings, written as files (fixed times, so every answer is the same each run). */
function scratchStore(): { store: MeetingStore; linkedSource: (record: { id: string }) => LinkedSource | undefined } {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-service-${process.pid}-${stores}`));

    for (const record of [REVIEW, RETRO]) {
        mkdirSync(store.folder(record.id), { recursive: true });
        writeFileSync(join(store.folder(record.id), MEETING_FILE), SafeJSON.stringify(record, null, 2));
    }

    const source = fakeSource();
    return {
        store,
        linkedSource: (record) => (record.id === REVIEW.id ? { source, sourceMeetingId: "wf-2041" } : undefined),
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
const quietDeps: MeetingsHandlerDeps = {
    now: () => NOW,
    ledger: () => undefined,
    readLedger: () => [],
    cut: fakeCut,
    probe: async () => ({ tracks: 1, channels: 2, durationSec: 45 }),
    hasFfmpeg: () => true,
    tone: async (_sound, path) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "RIFF");
    },
    // Ten seconds of 100 ms blocks: quiet, then the left channel loud from 4 s to 5 s.
    energy: async () => ({
        left: Float32Array.from({ length: 100 }, (_, block) => (block >= 40 && block < 50 ? 800 : 100)),
        right: Float32Array.from({ length: 100 }, () => 200),
    }),
};

async function startService(options: { dir?: string } = {}) {
    const { store, linkedSource } = scratchStore();
    const dir = options.dir ?? serviceDir();
    const start = await startMeetingsService({
        dir,
        store: () => store,
        linkedSource,
        idleMs: 0,
        code: CODE,
        ...quietDeps,
    });

    if (start.status !== "started") {
        throw new Error("the meetings service did not start");
    }

    closing.push(() => start.service.stop("test end"));
    return { dir, store, service: start.service };
}

interface Adapter {
    client: MeetingsClient;
    emit: (event: "meeting.changed", params: { meeting: string; parts: Array<"show" | "transcript"> }) => void;
    store: MeetingStore;
}

const ADAPTERS: Record<"socket" | "in-process", (caller?: MeetingsHello) => Promise<Adapter>> = {
    socket: async (caller = hello) => {
        const { service, store } = await startService();
        const client = await SocketMeetingsClient.connect(service.entry, caller);
        closing.push(() => client.close());
        return { client, store, emit: (event, params) => service.emit(event, params) };
    },
    "in-process": async (caller = hello) => {
        const { store, linkedSource } = scratchStore();
        const events = new LocalMeetingsEvents();
        const client = new InProcessMeetingsClient({
            hello: caller,
            deps: { store: () => store, linkedSource, ...quietDeps },
            events,
        });
        closing.push(() => client.close());
        return { client, store, emit: (event, params) => events.emit(event, params) };
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

    test("meeting.show answers the record by id or prefix; a missing or ambiguous ref is refused with its code", async () => {
        const { client } = await ADAPTERS[kind]();
        const record = await client.call("meeting.show", { ref: "2026-11-03-10" });

        expect(record).toEqual(meetingRecordSchema.parse(REVIEW));
        const missing = await failure(client.call("meeting.show", { ref: "nope" }));
        expect(missing).toBeInstanceOf(MeetingsServiceError);
        expect(missing).toMatchObject({ code: "meeting-not-found" });
        expect(errorText(missing)).toBe('No meeting "nope". List them: tools meetings list');
        const ambiguous = await failure(client.call("meeting.show", { ref: "2026-11-03" }));
        expect(ambiguous).toMatchObject({ code: "meeting-ref" });
        expect(errorText(ambiguous)).toBe(`"2026-11-03" fits 2 meetings: ${RETRO.id}, ${REVIEW.id}`);
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

    test("the timeline reads: line ends, speakers, screen, waveform; and the overview", async () => {
        const { client } = await ADAPTERS[kind]();
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
        expect(speakers.speakers.map((one) => one.label).sort()).toEqual(["Dana Example", "Speaker 2"]);
        expect(screen).toEqual({ meeting: REVIEW.id, recorded: false, displays: [], frames: [] });
        expect(waveform).toEqual({ meeting: REVIEW.id, fromSec: 0, toSec: 10, peaks: [0.25, 0.25, 1, 0.25, 0.25] });
        expect(overview.meetings.map((one) => one.id)).toEqual([RETRO.id, REVIEW.id]);
    });

    test("a subscription with an empty meeting is refused as invalid params instead of hearing every meeting", async () => {
        const { client } = await ADAPTERS[kind]();
        const refused = await failure(client.subscribe({ meeting: "" }, () => undefined));

        expect(refused).toMatchObject({ code: -32602 });
        expect(refused.message).toStartWith("subscribe: meeting:");
    });
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
        const second = await startMeetingsService({ dir, idleMs: 0, code: CODE, rivalWaitMs: 500 });

        expect(second).toMatchObject({ status: "running", entry: { pid: service.entry.pid, code: CODE } });
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
        const start = await startMeetingsService({ dir, store: () => store, linkedSource, idleMs: 0 });

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
        const start = await startMeetingsService({ dir, store: () => store, linkedSource, idleMs: 0 });

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
    const { service } = await startService();
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
    await ask(window, "meeting.show", { ref: "nope" }, "No meeting: meeting-not-found.");
    await ask(window, "meeting.show", { ref: "2026-11-03" }, "A prefix of two meetings: meeting-ref.");
    await ask(window, "meeting.transcript", { ref: REVIEW.id });
    await ask(window, "meeting.transcript", { ref: RETRO.id }, "No transcript source: a meeting state.");
    await ask(window, "meeting.revisions", { ref: REVIEW.id });
    await ask(window, "meetings.list", { limit: 0 }, "A bad param: -32602 before any handler.");
    await ask(window, SUBSCRIBE, { meeting: REVIEW.id, events: ["meeting.changed"] });
    service.emit("meeting.changed", { meeting: REVIEW.id, parts: ["show", "transcript"] });
    await ask(window, "meetings.list", { limit: 1 }, "Sent after the event, so the event is in before its reply.");
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
        { meeting: REVIEW.id, events: ["decision.applied", "decision.reverted"] },
        "The window hears every decision on the open meeting, with its journal entry."
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
    await ask(window, "meeting.speakers", { meeting: REVIEW.id }, "Talk time per label, its spans, and the hints.");
    await ask(window, "meeting.screen", { meeting: REVIEW.id }, "No screen recording: no frames, no pane.");
    await ask(
        window,
        "meeting.waveform",
        { meeting: REVIEW.id, fromSec: 0, toSec: 10, buckets: 5 },
        "Peaks for the strip, 0 to 1 of the loudest 100 ms."
    );
    await ask(window, "meetings.overview", { days: 3650 }, "The meetings with what each waits for.");
    await ask(window, "config.read", { path: "global.playback.listen.longestClipSec" });
    await ask(window, "config.set", { path: "global.playback.listen.longestClipSec", value: 25 });
    await ask(window, "config.unset", { path: "global.playback.listen.longestClipSec" }, "Back to its default.");
    for (const method of ["decision.applied", "decision.reverted"]) {
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
    return examples;
}

/**
 * Revision tokens hash file identities (inode, times), and a decision's token is a fresh UUID, so they differ each run;
 * everything else is fixed (the decisions' clock is `NOW`).
 */
function normalized(examples: Example[]): unknown {
    return SafeJSON.parse(
        SafeJSON.stringify(examples, { strict: true })
            .replace(/"(show|transcript|speakers|timeline)":"[0-9a-z]+"/g, '"$1":"<token>"')
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
            // Paths under the run's sandbox home and temp folders, and a clip's key (it hashes the recording's path).
            .replace(/"(path)":"[^"]*?(\/meetings-cache\/[^"]*?)-[0-9a-z]+\.wav"/g, '"$1":"<home>$2-<key>.wav"')
            .replace(/"path":"[^"]*\/upload\.ogg"/g, '"path":"<recording>"')
            .replace(/"path":"[^"]*\/meetings\/config\.json"/g, '"path":"<config>"')
            .replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"<now>"'),
        { strict: true }
    );
}

describe("the protocol fixture (__fixtures__/meetings-protocol.json)", () => {
    test("a live service on the scratch store answers every example as the fixture holds it", async () => {
        const captured = await captureExamples();

        // An emptied fixture is written again from the live service; review the diff before committing it.
        if (fixture.examples.length === 0) {
            const path = join(import.meta.dir, "__fixtures__/meetings-protocol.json");
            const document = {
                protocol: MEETINGS_PROTOCOL,
                about: "One real request and reply per Meetings service method and event (src/meetings/lib/service/api.ts), captured over raw sockets from the TypeScript service on a scratch store with invented meetings. The Swift client tests decode these; src/meetings/lib/service/service.test.ts checks every one against the method's schemas and against a live service. Regenerate: set examples to [] and run bun run test src/meetings/lib/service/service.test.ts",
                examples: captured,
            };
            mkdirSync(join(import.meta.dir, "__fixtures__"), { recursive: true });
            writeFileSync(path, `${SafeJSON.stringify(document, { strict: true }, 2)}\n`);
        }

        expect(normalized(captured)).toEqual(
            normalized(fixture.examples.length === 0 ? captured : (fixture.examples as Example[]))
        );
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
                "unplayable",
                "code-mismatch",
                "meeting-not-found",
                "meeting-ref",
                "no-hello",
                "no-transcript-source",
                "protocol-mismatch",
            ].sort()
        );
    });

    test("service.json names the service's protocol and code", async () => {
        const { dir } = await startService();
        const entry = SafeJSON.parse(await Bun.file(serviceEntryPath(dir)).text(), { strict: true });

        expect(entry).toMatchObject({ version: 1, protocol: MEETINGS_PROTOCOL, code: CODE });
    });
});
