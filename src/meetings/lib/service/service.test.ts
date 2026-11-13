import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WatcherOptions } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError, MeetingsStateError } from "@genesiscz/utils/meetings/conflict";
import { ContactsPeopleSource } from "@genesiscz/utils/meetings/people-contacts";
import { MEETING_FILE, MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { WordTimingCache, wordTimingFile } from "@genesiscz/utils/meetings/word-timing-cache";
import * as serviceHost from "@genesiscz/utils/rpc/service-host";
import { serviceEntryPath } from "@genesiscz/utils/rpc/service-host";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { Storage } from "@genesiscz/utils/storage/storage";
import { Command } from "commander";
import { z } from "zod";
import { registerServeCommand } from "../../commands/serve";
import { MeetingComments } from "../comments";
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
import { type MeetingsServiceOptions, startMeetingsService } from "./service";

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

/**
 * A scratch store with the two meetings, written as files (fixed times, so every answer is the same each run), and a
 * scratch meetings config for the library methods.
 */
function scratchStore(): {
    store: MeetingStore;
    config: MeetingsConfigStore;
    linkedSource: (record: { id: string }) => LinkedSource | undefined;
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
        linkedSource: (record) => (record.id === REVIEW.id ? { source, sourceMeetingId: "wf-2041" } : undefined),
    };
}

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
    localSourceAudio: [],
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
    options: { dir?: string; watch?: MeetingsServiceOptions["watch"]; deps?: Partial<MeetingsHandlerDeps> } = {}
) {
    const { store, config, linkedSource } = scratchStore();
    const dir = options.dir ?? serviceDir();
    const start = await startMeetingsService({
        dir,
        store: () => store,
        configStore: () => config,
        linkedSource,
        idleMs: 0,
        code: CODE,
        watch: options.watch ?? false,
        ...quietDeps,
        ...options.deps,
    });

    if (start.status !== "started") {
        throw new Error("the meetings service did not start");
    }

    closing.push(() => start.service.stop("test end"));
    return { dir, store, config, service: start.service };
}

interface Adapter {
    client: MeetingsClient;
    emit: (event: "meeting.changed", params: { meeting: string; parts: Array<"show" | "transcript"> }) => void;
    store: MeetingStore;
    /** The meetings config the library methods change. */
    config: MeetingsConfigStore;
}

const ADAPTERS: Record<"socket" | "in-process", (caller?: MeetingsHello) => Promise<Adapter>> = {
    socket: async (caller = hello) => {
        const { service, store, config } = await startService();
        const client = await SocketMeetingsClient.connect(service.entry, caller);
        closing.push(() => client.close());
        return { client, store, config, emit: (event, params) => service.emit(event, params) };
    },
    "in-process": async (caller = hello) => {
        const { store, config, linkedSource } = scratchStore();
        const events = new LocalMeetingsEvents();
        const client = new InProcessMeetingsClient({
            hello: caller,
            deps: { store: () => store, configStore: () => config, linkedSource, ...quietDeps },
            events,
        });
        closing.push(() => client.close());
        return { client, store, config, emit: (event, params) => events.emit(event, params) };
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
    test("threshold previews load together without persisting a rendering preference or record mutation", async () => {
        const { client, store } = await ADAPTERS[kind]();
        const before = readFileSync(store.path(REVIEW.id));
        const result = await client.call("meeting.transcript", { ref: REVIEW.id, previewThresholds: [0.5, 0.7, 1] });
        expect(result.previews?.map((preview) => preview.threshold)).toEqual([0.5, 0.7, 1]);
        expect(result.previews?.every((preview) => preview.entries.length > 0)).toBe(true);
        expect(readFileSync(store.path(REVIEW.id))).toEqual(before);
        expect(new MeetingStore(store.storage).read(REVIEW.id)?.id).toBe(REVIEW.id);
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
        expect(reopened.seats?.room).toContain("River Example");
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

    test("meeting.show answers the record by id or prefix; a missing or ambiguous ref is refused with its code", async () => {
        const { client } = await ADAPTERS[kind]();
        const record = await client.call("meeting.show", { ref: "2026-11-03-10" });

        expect(record).toEqual(meetingRecordSchema.parse(REVIEW));
        const missing = await failure(client.call("meeting.show", { ref: "nope" }));
        expect(missing).toBeInstanceOf(MeetingsServiceError);
        expect(missing).toMatchObject({ code: "meeting-not-found" });
        expect(errorText(missing)).toBe('[meeting-not-found] No meeting "nope". List them: tools meetings list');
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
            { kind: "reason", pieces: [{ text: "Rules: presence" }] },
        ]);

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
    });

    test("the dictionary: add, show, test, a refused Undo's add, a rename and remove", async () => {
        const { client } = await ADAPTERS[kind]();
        const fix = { type: "fix" as const, value: "Atlass", substitution: "Atlas" };

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
    return examples;
}

/**
 * Revision tokens hash file identities (inode, times), and a decision's token is a fresh UUID, so they differ each run;
 * everything else is fixed (the decisions' clock is `NOW`).
 */
function normalized(examples: Example[]): unknown {
    return SafeJSON.parse(
        SafeJSON.stringify(examples, { strict: true })
            .replace(/"meetingsRoot":"[^"]*"/g, '"meetingsRoot":"<meetings>"')
            .replace(/"(show|transcript|speakers|timeline)":"[0-9a-z]+"/g, '"$1":"<token>"')
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
            // Paths under the run's sandbox home and temp folders, and a clip's key (it hashes the recording's path).
            .replace(/"(path)":"[^"]*?(\/meetings-cache\/[^"]*?)-[0-9a-z]+\.wav"/g, '"$1":"<home>$2-<key>.wav"')
            .replace(/"path":"[^"]*\/upload\.ogg"/g, '"path":"<recording>"')
            .replace(/"path":"[^"]*\/meetings\/config\.json"/g, '"path":"<config>"')
            .replace(
                /"(path|ref)":"[^"]*\/(2026-11-03-1000-design-review\/clips\/[^"/]+?)-[0-9a-z]+\.wav"/g,
                '"$1":"<meetings>/$2-<key>.wav"'
            )
            // A removed project's backup: under the sandbox home, named by the local time of the removal.
            .replace(/"backup":"[^"]*"/g, '"backup":"<backup>"')
            .replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"<now>"')
            .replace(
                /"(cacheRevision|revision|audioFingerprint|modelFingerprint|id)":"[a-f0-9]{64}"/g,
                '"$1":"<timing-hash>"'
            )
            // An error's stack names this checkout's paths and line numbers.
            .replace(
                /"(path|folder)":"[^"\n]*\/(2026-11-03-1400-retro(?:\/frames\/screen\.png)?)"/g,
                '"$1":"<meetings>/$2"'
            )
            .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
            // A file preset's availability is the host's (/System/Library/Sounds is on a Mac only).
            .replace(/"available":(true|false)/g, '"available":"<host>"'),
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
    test("a live service on the scratch store answers every example as the fixture holds it", async () => {
        const captured = await captureExamples();

        // An emptied fixture is written again from the live service; review the diff before committing it.
        if (fixture.examples.length === 0) {
            const path = join(import.meta.dir, "__fixtures__/meetings-protocol.json");
            const document = {
                protocol: MEETINGS_PROTOCOL,
                about: "One real request and reply per Meetings service method and event (src/meetings/lib/service/api.ts), captured over raw sockets from the TypeScript service on a scratch store with invented meetings. The Swift client tests decode these; src/meetings/lib/service/service.test.ts checks every one against the method's schemas and against a live service. Regenerate: set examples to [] and run bun run test src/meetings/lib/service/service.test.ts",
                examples: SafeJSON.parse(
                    SafeJSON.stringify(captured, { strict: true })
                        .replace(/"meetingsRoot":"[^"]*"/g, '"meetingsRoot":"<meetings>"')
                        .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
                        .replace(
                            /"(path|ref)":"[^"]*\/(2026-11-03-1000-design-review\/clips\/[^"/]+?)-[0-9a-z]+\.wav"/g,
                            '"$1":"<meetings>/$2-<key>.wav"'
                        )
                        .replace(
                            /"(path|folder)":"[^"\n]*\/(2026-11-03-1400-retro(?:\/frames\/screen\.png)?)"/g,
                            '"$1":"<meetings>/$2"'
                        ),
                    { strict: true }
                ),
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
            ].sort()
        );
    });

    test("service.json names the service's protocol and code", async () => {
        const { dir } = await startService();
        const entry = SafeJSON.parse(await Bun.file(serviceEntryPath(dir)).text(), { strict: true });

        expect(entry).toMatchObject({ version: 1, protocol: MEETINGS_PROTOCOL, code: CODE });
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
});
