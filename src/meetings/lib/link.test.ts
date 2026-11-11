import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { wisprflowSource } from "@app/wisprflow/lib/meeting-source";
import type { LinkGate } from "@genesiscz/utils/browser-router/link-gate";
import { env } from "@genesiscz/utils/env";
import * as cloneFiles from "@genesiscz/utils/fs/clone";
import * as hashFiles from "@genesiscz/utils/fs/hash";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import * as rm from "@genesiscz/utils/rm";
import * as atomicFile from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { ANSWER_LOG_FILE, appendAnswerEvent, readAnswerEvents, roundRunning } from "./answer-log";
import type { AssignInbox } from "./assign-inbox";
import { COMMENTS_FILE, MeetingComments } from "./comments";
import { DecisionJournal, JOURNAL_FILE } from "./decision-journal";
import { copyTitle, duplicateMeeting } from "./duplicate";
import { applySource, assertSourceFree, playLinksFor, sourceHolders } from "./link";
import { meetingListRow } from "./list-rows";
import * as mergeFiles from "./merge";
import { mergeMeetings } from "./merge";
import { meetingListRowSchema } from "./service/api";
import { showText } from "./show-text";
import {
    preservedSourceAudio,
    preserveSourceAudio,
    SOURCE_AUDIO_FOLDER,
    syncSourceAudio,
    withPreservedSourceAudio,
} from "./source-audio";

function gate(enabled: boolean, linkHost: string | null = "links.example"): LinkGate {
    return {
        version: 2,
        at: Date.now(),
        configMtimeMs: 0,
        installed: true,
        defaultHandler: true,
        httpsHandler: "GenesisTools",
        configured: true,
        linkHost,
        presets: { "meetings-play": { available: true, enabled, routed: enabled, missing: [] } },
    };
}

describe("transcript --play-links", () => {
    test("a preset that is on gives the links and no warning", () => {
        const links = playLinksFor("2026-11-02_15-00-planning", gate(true));

        expect(links.link(83)).toBe("https://links.example/meetings/play?meeting=2026-11-02_15-00-planning&at=01%3A23");
        expect(links.warning).toBeUndefined();
    });

    test("a preset that is off still writes the links, and warns how to switch it on", () => {
        const links = playLinksFor("2026-11-02_15-00-planning", gate(false));

        expect(links.link(83)).toContain("https://links.example/meetings/play?meeting=2026-11-02_15-00-planning");
        expect(links.warning).toContain("presets enable meetings-play");
    });

    test("without a link host there is nothing to link to", () => {
        const links = playLinksFor("2026-11-02_15-00-planning", gate(false, null));

        expect(links.link(83)).toBeNull();
        expect(links.warning).toContain("No play links");
    });
});

let stores = 0;

async function twoRecords(): Promise<{ store: MeetingStore; first: string; second: string }> {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-link-guard-${process.pid}-${stores}`));
    const first = await store.create(
        {
            title: "Planning",
            start: "2026-11-05T13:02:36.000Z",
            createdBy: "record",
            sources: { wisprflow: { meetingId: "7e900336-aaaa" } },
        },
        { command: "test", change: "created" }
    );
    const second = await store.create(
        { title: "Meeting 14:29", start: "2026-11-05T13:29:23.000Z", createdBy: "record" },
        { command: "test", change: "created" }
    );
    return { store, first: first.id, second: second.id };
}

describe("link: one source meeting, one record (MC1)", () => {
    test("linking a source meeting that another record holds is refused with [source-linked] and the merge command", async () => {
        const { store, first, second } = await twoRecords();
        const link = () =>
            assertSourceFree({ store, sourceId: "wisprflow", sourceMeetingId: "7e900336-aaaa", targetId: second });

        expect(link).toThrow(MeetingsConflictError);
        expect(link).toThrow(`wisprflow:7e900336-aaaa is linked to ${first} already.`);
        expect(link).toThrow(`tools meetings merge ${second} --into ${first}`);
    });

    test("linking again to the record that holds it, or a free source meeting, passes", async () => {
        const { store, first, second } = await twoRecords();

        expect(() =>
            assertSourceFree({ store, sourceId: "wisprflow", sourceMeetingId: "7e900336-aaaa", targetId: first })
        ).not.toThrow();
        expect(() =>
            assertSourceFree({ store, sourceId: "wisprflow", sourceMeetingId: "other", targetId: second })
        ).not.toThrow();
    });

    test("a refresh reaches a record that holds the source meeting already, even beside another holder", async () => {
        const { store, first, second } = await twoRecords();
        await store.update(second, { command: "test", change: "second link" }, (record) => {
            record.sources.wisprflow = { meetingId: "7e900336-aaaa" };
        });
        const guard = (targetId: string, refresh?: boolean) => () =>
            assertSourceFree({ store, sourceId: "wisprflow", sourceMeetingId: "7e900336-aaaa", targetId, refresh });

        expect(guard(first, true)).not.toThrow();
        expect(guard(second, true)).not.toThrow();
        expect(guard(second)).toThrow(MeetingsConflictError);

        const third = await store.create(
            { title: "Other", start: "2026-11-05T15:00:00.000Z", createdBy: "record" },
            { command: "test", change: "created" }
        );
        expect(guard(third.id, true)).toThrow(MeetingsConflictError);
    });

    test("a holder is matched by the whole id, never by a prefix", async () => {
        const { store } = await twoRecords();

        expect(sourceHolders({ store, sourceId: "wisprflow", sourceMeetingId: "7e900336" })).toEqual([]);
    });
});

describe("link: the call's start (MC2)", () => {
    const meeting: SourceMeeting = {
        sourceMeetingId: "7e900336-aaaa",
        title: "Planning",
        start: "2026-11-05T13:02:36.208Z",
        end: "2026-11-05T13:55:21.373Z",
        folders: [],
        participants: [],
        speakers: [],
        transcript: [],
    };

    function recordAt(start: string) {
        return meetingRecordSchema.parse({
            id: "r1",
            title: "Meeting 14:29",
            start,
            createdAt: start,
            createdBy: "record",
        });
    }

    test("a record made when the screen recording started takes the earlier start of the call", () => {
        const record = recordAt("2026-11-05T13:29:23.162Z");
        applySource({ record, sourceId: "wisprflow", block: { meetingId: "7e900336-aaaa" }, meeting });

        expect(record.start).toBe("2026-11-05T13:02:36.208Z");
        expect(record.end).toBe("2026-11-05T13:55:21.373Z");
    });

    test("a link keeps a later end and takes the source's end when the record ended earlier (a resumed call)", () => {
        const record = recordAt("2026-11-05T13:29:23.162Z");
        record.end = "2026-11-05T13:49:00.000Z";
        applySource({ record, sourceId: "wisprflow", block: { meetingId: "7e900336-aaaa" }, meeting });
        expect(record.end).toBe("2026-11-05T13:55:21.373Z");

        record.end = "2026-11-05T14:10:00.000Z";
        applySource({ record, sourceId: "wisprflow", block: { meetingId: "7e900336-aaaa" }, meeting });
        expect(record.end).toBe("2026-11-05T14:10:00.000Z");
    });

    test("a record that started before the call keeps its own start", () => {
        const record = recordAt("2026-11-05T12:58:00.000Z");
        applySource({ record, sourceId: "wisprflow", block: { meetingId: "7e900336-aaaa" }, meeting });

        expect(record.start).toBe("2026-11-05T12:58:00.000Z");
    });
});

describe("merge: two records of one call become one (MC1 repair)", () => {
    async function call(options: { collide?: boolean; otherSource?: boolean; formOpen?: boolean } = {}) {
        stores += 1;
        const storage = new Storage(`meetings-merge-${process.pid}-${stores}`);
        const store = new MeetingStore(storage);
        const span = (from: string, to: string) => ({ from, to, stopReason: "requested" as const });
        const from = await store.create(
            {
                title: "Planning",
                start: "2026-11-05T13:02:36.000Z",
                createdBy: "record",
                sources: { wisprflow: { meetingId: "call-1" } },
                recording: {
                    frames: 1,
                    bytes: 10,
                    spans: [span("2026-11-05T13:03:00.000Z", "2026-11-05T13:27:00.000Z")],
                    displays: [{ id: 1, name: "Built-in", frames: 1 }],
                },
                assign: {
                    ask: {
                        formId: "form-1",
                        askedAt: "2026-11-05T13:07:00.000Z",
                        outcome: "pending",
                        proposals: [],
                        calendars: [],
                    },
                },
            },
            { command: "test", change: "created" }
        );
        const into = await store.create(
            {
                title: "Meeting 14:29",
                start: "2026-11-05T13:29:23.000Z",
                createdBy: "record",
                project: "work",
                sources: { wisprflow: { meetingId: options.otherSource ? "call-2" : "call-1" } },
                recording: {
                    frames: 1,
                    bytes: 20,
                    spans: [span("2026-11-05T13:29:23.000Z", "2026-11-05T14:07:00.000Z")],
                    displays: [{ id: 1, name: "Built-in", frames: 1 }],
                },
            },
            { command: "test", change: "created" }
        );
        const write = (id: string, name: string, at: string) => {
            mkdirSync(join(store.folder(id), "frames"), { recursive: true });
            writeFileSync(join(store.folder(id), "frames", name), "jpg");
            appendFileSync(
                join(store.folder(id), "ocr.jsonl"),
                `${SafeJSON.stringify({ file: `frames/${name}`, at, text: "x" })}\n`
            );
        };
        write(from.id, "14-03-00-000-d1.jpg", "2026-11-05T13:03:00.000Z");
        write(into.id, options.collide ? "14-03-00-000-d1.jpg" : "14-29-25-000-d1.jpg", "2026-11-05T13:29:25.000Z");
        writeFileSync(join(store.folder(into.id), "recording.json"), "{}");
        const cancelled: string[] = [];
        const inbox: AssignInbox = {
            post: async () => ({ id: "unused" }),
            read: async () => null,
            cancel: async (id) => {
                cancelled.push(id);
                return options.formOpen ?? true;
            },
        };
        return {
            store,
            from: from.id,
            into: into.id,
            inbox,
            cancelled,
            backupRoot: join(storage.getBaseDir(), "backups"),
        };
    }

    test("frames, rows, spans and history move; the start, the title and the question follow the call", async () => {
        const { store, from, into, inbox, cancelled, backupRoot } = await call();
        const result = await mergeMeetings({
            store,
            fromId: from,
            intoId: into,
            inbox,
            backupRoot,
            now: new Date(2026, 10, 6, 21, 30),
        });
        const merged = store.read(into);
        const rows = readFileSync(join(store.folder(into), "ocr.jsonl"), "utf8")
            .trim()
            .split("\n");

        expect(readdirSync(join(store.folder(into), "frames")).sort()).toEqual([
            "14-03-00-000-d1.jpg",
            "14-29-25-000-d1.jpg",
        ]);
        expect(rows.map((row) => SafeJSON.parse(row).file)).toEqual([
            "frames/14-03-00-000-d1.jpg",
            "frames/14-29-25-000-d1.jpg",
        ]);
        expect(merged?.start).toBe("2026-11-05T13:02:36.000Z");
        expect(merged?.title).toBe("Planning");
        expect(merged?.project).toBe("work");
        expect(merged?.recording?.frames).toBe(2);
        expect(merged?.recording?.displays).toEqual([{ id: 1, name: "Built-in", frames: 2 }]);
        expect(merged?.recording?.spans?.map((one) => one.from)).toEqual([
            "2026-11-05T13:03:00.000Z",
            "2026-11-05T13:29:23.000Z",
        ]);
        expect(merged?.history.some((entry) => entry.command === "merge")).toBe(true);
        expect(store.read(from)).toBeUndefined();
        expect(existsSync(join(store.folder(into), "recording.json"))).toBe(false);
        expect(result.backup).toBe(join(backupRoot, `2026-11-06-2130-merge-${from}`));
        expect(existsSync(join(result.backup ?? "", "before", from, "frames", "14-03-00-000-d1.jpg"))).toBe(true);
        expect(existsSync(join(result.backup ?? "", "before", into, "recording.json"))).toBe(true);
        expect(existsSync(join(result.backup ?? "", "moved", from, "meeting.json"))).toBe(true);
        expect(cancelled).toEqual(["form-1"]);
        expect(result.withdrawn).toBe("form-1");
        expect(store.resolve("wisprflow:call-1")?.id).toBe(into);
    });

    test("a question the inbox no longer holds open is reported as not withdrawn, not as withdrawn", async () => {
        const { store, from, into, inbox, cancelled, backupRoot } = await call({ formOpen: false });
        const result = await mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot });

        expect(cancelled).toEqual(["form-1"]);
        expect(result.withdrawn).toBeUndefined();
        expect(result.notOpen).toBe("form-1");
    });

    test("a dry run changes nothing", async () => {
        const { store, from, into, inbox, cancelled, backupRoot } = await call();
        const result = await mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot, dryRun: true });

        expect(result.moved.frames).toBe(1);
        expect(store.read(from)?.id).toBe(from);
        expect(existsSync(backupRoot)).toBe(false);
        expect(cancelled).toEqual([]);
    });

    test.each(["frames.jsonl", "ocr.jsonl", "audio.jsonl"])(
        "a torn %s is refused before any frame moves, naming the file and line",
        async (name) => {
            const { store, from, into, inbox, backupRoot } = await call();
            const ocr = join(store.folder(from), name);
            writeFileSync(ocr, '{"at":"2026-11-05T13:03:00.000Z"}\n{"file":"frames/cut');

            await expect(mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot })).rejects.toThrow(
                `${ocr}:2 is not a JSON row`
            );
            expect(readdirSync(join(store.folder(from), "frames"))).toEqual(["14-03-00-000-d1.jpg"]);
            expect(readdirSync(join(store.folder(into), "frames"))).toEqual(["14-29-25-000-d1.jpg"]);
            expect(store.read(from)?.id).toBe(from);
            expect(existsSync(backupRoot)).toBe(false);
        }
    );

    test("the backup is owner-only whatever the umask, down to every folder and file it clones", async () => {
        const { store, from, into, inbox, backupRoot } = await call();
        const frame = join(store.folder(from), "frames", "14-03-00-000-d1.jpg");
        chmodSync(frame, 0o644);
        const umask = process.umask(0o022);

        try {
            const { backup = "" } = await mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot });
            const mode = (path: string) => statSync(path).mode & 0o777;

            expect(mode(backup)).toBe(0o700);
            expect(mode(join(backup, "before"))).toBe(0o700);
            expect(mode(join(backup, "before", from, "frames"))).toBe(0o700);
            expect(mode(join(backup, "before", from, "frames", "14-03-00-000-d1.jpg"))).toBe(0o600);
            expect(mode(join(backup, "moved-rows"))).toBe(0o700);
            expect(mode(join(backup, "README.md"))).toBe(0o600);
        } finally {
            process.umask(umask);
        }
    });

    test("both merge directions acquire the same lock order and hold both locks while reading records", async () => {
        for (const reverse of [false, true]) {
            const { store, from, into, inbox, backupRoot } = await call();
            const acquire = store.storage.withFileLock.bind(store.storage);
            const read = store.read.bind(store);
            const active = new Set<string>();
            const acquired: string[] = [];
            let lockedReads = 0;
            store.storage.withFileLock = (options) =>
                acquire({
                    ...options,
                    fn: async () => {
                        acquired.push(options.file);
                        active.add(options.file);
                        try {
                            return await options.fn();
                        } finally {
                            active.delete(options.file);
                        }
                    },
                });
            store.read = (id) => {
                if (active.size > 0) {
                    expect([...active].sort()).toEqual([store.path(from), store.path(into)].sort());
                    lockedReads += 1;
                }

                return read(id);
            };

            await mergeMeetings({
                store,
                fromId: reverse ? into : from,
                intoId: reverse ? from : into,
                inbox,
                backupRoot,
            });
            expect(acquired).toEqual([store.path(from), store.path(into)].sort());
            expect(lockedReads).toBeGreaterThanOrEqual(2);
            expect(active.size).toBe(0);
        }
    });

    test("merge rereads both records after acquiring their locks and preserves a concurrent source edit", async () => {
        const { store, from, into, inbox, backupRoot } = await call();
        const acquire = store.storage.withFileLock.bind(store.storage);
        let injected = false;
        store.storage.withFileLock = async (options) => {
            if (!injected && options.file === store.path(into)) {
                injected = true;
                const current = store.read(from)!;
                current.context.push({
                    id: "c1",
                    kind: "note",
                    ref: "arrived while waiting for the lock",
                    addedAt: "2026-11-05T14:08:00.000Z",
                    addedBy: "user",
                });
                writeFileSync(store.path(from), SafeJSON.stringify(current));
            }

            return acquire(options);
        };

        await mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot });
        const reopened = new MeetingStore(store.storage);
        expect(reopened.read(into)?.context.some((item) => item.ref === "arrived while waiting for the lock")).toBe(
            true
        );
        expect(reopened.read(from)).toBeUndefined();
    });

    test("merge revalidates the destination source link under both locks before moving files", async () => {
        const { store, from, into, inbox, backupRoot } = await call();
        const acquire = store.storage.withFileLock.bind(store.storage);
        let injected = false;
        store.storage.withFileLock = async (options) => {
            if (!injected && options.file === store.path(into)) {
                injected = true;
                const current = store.read(into)!;
                current.sources.wisprflow = { meetingId: "a-different-call" };
                writeFileSync(store.path(into), SafeJSON.stringify(current));
            }

            return acquire(options);
        };

        await expect(mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot })).rejects.toThrow(
            "hold different source meetings"
        );
        expect(existsSync(backupRoot)).toBe(false);
        expect(readdirSync(join(store.folder(from), "frames"))).toEqual(["14-03-00-000-d1.jpg"]);
        expect(new MeetingStore(store.storage).read(from)?.id).toBe(from);
    });

    test("the dictionary and the stored attendance of the record that goes away come along", async () => {
        const { store, from, into, inbox, backupRoot } = await call();
        const attendance = { from: "teams", people: [{ name: "Alice", fromSec: 0, toSec: 60 }] };
        await store.update(from, { command: "test", change: "words and attendance" }, (next) => {
            next.dictionary = {
                entries: [
                    { type: "term", value: "Kuber", meaning: "from" },
                    { type: "term", value: "JDZ", spoken: ["jenezetka"] },
                ],
            };
            next.attendance = attendance;
            next.sections = [{ fromSec: 0, toSec: 60, present: ["Alice"] }];
        });
        await store.update(into, { command: "test", change: "words" }, (next) => {
            next.dictionary = { entries: [{ type: "term", value: "Kuber", meaning: "into" }] };
        });

        await mergeMeetings({ store, fromId: from, intoId: into, inbox, backupRoot });
        const merged = store.read(into);

        expect(merged?.dictionary?.entries).toEqual([
            { type: "term", value: "Kuber", meaning: "into" },
            { type: "term", value: "JDZ", spoken: ["jenezetka"] },
        ]);
        // Both records hold one source meeting, so the stays keep their seconds on its clock.
        expect(merged?.attendance).toEqual(attendance);
        expect(merged?.sections).toEqual([{ fromSec: 0, toSec: 60, present: ["Alice"] }]);
    });

    test("attendance on a record's own clock moves onto the merged clock, or is refused when it cannot be placed", async () => {
        const unlinked = await call();
        await unlinked.store.update(unlinked.from, { command: "test", change: "attendance" }, (next) => {
            next.sources = {};
            next.attendance = { from: "teams", people: [{ name: "Alice", fromSec: 1700, toSec: 1760 }] };
            next.sections = [{ fromSec: 1700, toSec: 1760, present: ["Alice"] }];
        });
        await unlinked.store.update(unlinked.into, { command: "test", change: "a recording clock" }, (next) => {
            next.sources = {};
            next.recording = { ...next.recording, clock: { source: "test", startedAt: "2026-11-05T13:29:23.000Z" } };
        });

        const { store, inbox, backupRoot } = unlinked;
        await mergeMeetings({ store, fromId: unlinked.from, intoId: unlinked.into, inbox, backupRoot });
        // Second 0 moved from 13:02:36 (the record's start) to 13:29:23 (the recording clock it keeps): 1607 s later.
        expect(unlinked.store.read(unlinked.into)?.attendance?.people).toEqual([
            { name: "Alice", fromSec: 93, toSec: 153 },
        ]);
        expect(unlinked.store.read(unlinked.into)?.sections).toEqual([{ fromSec: 93, toSec: 153, present: ["Alice"] }]);

        const linkedInto = await call();
        await linkedInto.store.update(linkedInto.from, { command: "test", change: "attendance" }, (next) => {
            next.sources = {};
            next.attendance = { from: "teams", people: [{ name: "Alice", fromSec: 0, toSec: 60 }] };
        });

        await expect(
            mergeMeetings({
                store: linkedInto.store,
                fromId: linkedInto.from,
                intoId: linkedInto.into,
                inbox: linkedInto.inbox,
                backupRoot: linkedInto.backupRoot,
            })
        ).rejects.toThrow("keeps attendance on its own recording clock");
        expect(linkedInto.store.read(linkedInto.from)?.attendance?.people).toHaveLength(1);
        expect(existsSync(linkedInto.backupRoot)).toBe(false);
    });

    test("records of two calls, or frames that share a name, are refused before anything moves", async () => {
        const two = await call({ otherSource: true });

        await expect(
            mergeMeetings({ store: two.store, fromId: two.from, intoId: two.into, inbox: two.inbox })
        ).rejects.toThrow("hold different source meetings");

        const same = await call({ collide: true });

        await expect(
            mergeMeetings({ store: same.store, fromId: same.from, intoId: same.into, inbox: same.inbox })
        ).rejects.toThrow("frames/14-03-00-000-d1.jpg is in both records");
        expect(readdirSync(join(same.store.folder(same.from), "frames"))).toEqual(["14-03-00-000-d1.jpg"]);
    });
});

describe("duplicate: a second record of one meeting", () => {
    let previousHome: string;
    let fixtureHome: string;
    let restoreDrainer: (() => void) | undefined;

    beforeEach(() => {
        previousHome = env.tools.getHome();
        fixtureHome = mkdtempSync(join(tmpdir(), "meetings-duplicate-"));
        env.testing.set("GENESIS_TOOLS_HOME", fixtureHome);
        rm.saveRmConfig({ ...rm.defaultRmConfig(), trashRoot: join(fixtureHome, "GenesisTools", "rm") });
        const drainer = spyOn(rm, "kickDrainer").mockImplementation(() => {});
        restoreDrainer = () => drainer.mockRestore();
    });

    afterEach(() => {
        restoreDrainer?.();
        env.testing.set("GENESIS_TOOLS_HOME", previousHome);
    });
    test("a killed copy stays unpublished and the next Duplicate reclaims it before retrying", async () => {
        stores += 1;
        const namespace = `meetings-duplicate-crash-${process.pid}-${stores}`;
        const store = new MeetingStore(new Storage(namespace));
        const original = await store.create(
            { title: "Planning", start: "2026-11-05T13:02:36.000Z", createdBy: "new" },
            { command: "test", change: "created" }
        );
        writeFileSync(join(store.folder(original.id), "capture.txt"), "original bytes");
        const code = `
            import { spyOn } from "bun:test";
            import { writeFileSync } from "node:fs";
            import { MeetingStore } from "@genesiscz/utils/meetings/record";
            import { env } from "@genesiscz/utils/env";
            env.testing.set("GENESIS_TOOLS_HOME", ${SafeJSON.stringify(env.tools.getHome())});
            import { Storage } from "@genesiscz/utils/storage/storage";
            import * as merge from ${SafeJSON.stringify(new URL("./merge.ts", import.meta.url).pathname)};
            import { duplicateMeeting } from ${SafeJSON.stringify(new URL("./duplicate.ts", import.meta.url).pathname)};
            const store = new MeetingStore(new Storage(${SafeJSON.stringify(namespace)}));
            if (store.root !== ${SafeJSON.stringify(store.root)}) throw new Error("Unexpected fixture root");
            spyOn(merge, "cloneTree").mockImplementation((_source, destination) => {
                writeFileSync(destination, "interrupted bytes");
                process.kill(process.pid, "SIGKILL");
            });
            await duplicateMeeting({ store, ref: ${SafeJSON.stringify(original.id)} });
        `;
        const child = Bun.spawn([process.execPath, "--eval", code], {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
        });
        const deadline = setTimeout(() => child.kill("SIGKILL"), 4_000);
        try {
            const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
            expect(stderr).not.toContain("error:");
            expect(exit).not.toBe(0);
        } finally {
            clearTimeout(deadline);
            child.kill("SIGKILL");
        }
        const pending = join(store.root, ".duplicate-pending");
        const claims = readdirSync(pending).filter((name) => name.endsWith(".pid"));
        expect(claims).toHaveLength(1);
        const id = claims[0]!.slice(0, -4);
        expect(existsSync(store.path(id))).toBe(false);
        expect(new MeetingStore(store.storage).list().map((record) => record.id)).toEqual([original.id]);
        expect(readFileSync(join(store.folder(id), "capture.txt"), "utf8")).toBe("interrupted bytes");
        const copy = await duplicateMeeting({ store, ref: original.id });
        if (copy.id !== id) {
            expect(existsSync(store.folder(id))).toBe(false);
        }
        expect(readFileSync(join(store.folder(copy.id), "capture.txt"), "utf8")).toBe("original bytes");
        expect(readdirSync(pending).filter((name) => name.endsWith(".pid"))).toEqual([]);
        expect(new MeetingStore(store.storage).list()).toHaveLength(2);
        expect(readFileSync(join(store.folder(original.id), "capture.txt"), "utf8")).toBe("original bytes");
    });

    test("a record publication failure takes back all prepared copy files", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            { title: "Planning", start: "2026-11-05T13:02:36.000Z", createdBy: "new" },
            { command: "test", change: "created" }
        );
        writeFileSync(join(store.folder(original.id), "capture.txt"), "original bytes");
        const realWrite = atomicFile.atomicWriteFileSync;
        const write = spyOn(atomicFile, "atomicWriteFileSync").mockImplementation((file, data, options) => {
            if (file !== store.path(original.id) && file.endsWith("/meeting.json")) {
                throw new Error("ENOSPC: publication failed");
            }
            realWrite(file, data, options);
        });
        try {
            await expect(duplicateMeeting({ store, ref: original.id })).rejects.toThrow("ENOSPC: publication failed");
        } finally {
            write.mockRestore();
        }
        expect(new MeetingStore(store.storage).list().map((record) => record.id)).toEqual([original.id]);
        expect(readdirSync(store.root).filter((name) => name.startsWith("2026-"))).toEqual([original.id]);
        expect(readdirSync(join(store.root, ".duplicate-pending")).filter((name) => name.endsWith(".pid"))).toEqual([]);
        expect(readFileSync(join(store.folder(original.id), "capture.txt"), "utf8")).toBe("original bytes");
    });

    test("a copy is invisible until its files are complete and a copy failure leaves no record", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            { title: "Planning", start: "2026-11-05T13:02:36.000Z", createdBy: "new" },
            { command: "test", change: "created" }
        );
        writeFileSync(join(store.folder(original.id), "capture.txt"), "original bytes");
        const recordBefore = readFileSync(store.path(original.id), "utf8");
        let visibleDuringCopy: string[] = [];
        let unfinishedFolder = "";
        const clone = spyOn(mergeFiles, "cloneTree").mockImplementation((_from, to) => {
            visibleDuringCopy = new MeetingStore(store.storage).list().map((record) => record.id);
            unfinishedFolder = dirname(to);
            writeFileSync(to, "partial copy");
            throw new Error("ENOSPC: fixture copy failed");
        });
        try {
            await expect(duplicateMeeting({ store, ref: original.id })).rejects.toThrow("ENOSPC");
            expect(visibleDuringCopy).toEqual([original.id]);
            expect(existsSync(unfinishedFolder)).toBe(false);
            const discarded = rm
                .listBatches()
                .flatMap((batch) => batch.items)
                .filter((item) => item.original === unfinishedFolder);
            expect(discarded.length).toBeGreaterThan(0);
            const privateTrash = join(realpathSync(fixtureHome), "GenesisTools", "rm") + sep;
            for (const item of discarded) {
                expect(item.stored.startsWith(privateTrash)).toBe(true);
            }
            const partial = discarded.find((item) => existsSync(join(item.stored, "capture.txt")));
            expect(partial).toBeDefined();
            expect(readFileSync(join(partial!.stored, "capture.txt"), "utf8")).toBe("partial copy");
            expect(new MeetingStore(store.storage).list().map((record) => record.id)).toEqual([original.id]);
            expect(readFileSync(store.path(original.id), "utf8")).toBe(recordBefore);
            expect(readFileSync(join(store.folder(original.id), "capture.txt"), "utf8")).toBe("original bytes");
        } finally {
            clone.mockRestore();
        }
    });

    test.each(["recording", "paused"] as const)(
        "an orphaned %s copy ends its capture intervals without changing the original",
        async (status) => {
            stores += 1;
            const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
            const at = (seconds: number) =>
                new Date(Date.parse("2026-11-05T13:02:36.000Z") + seconds * 1000).toISOString();
            const original = await store.create(
                {
                    title: "Planning",
                    start: at(0),
                    createdBy: "record",
                    recording: {
                        status,
                        startedAt: at(0),
                        spans: [{ from: at(0), to: at(10) }, { from: at(20) }],
                        displaySpans: [
                            { displayId: 1, from: at(0), to: at(10) },
                            { displayId: 2, from: at(20) },
                        ],
                    },
                },
                { command: "test", change: "recorder died" }
            );
            const frames = join(store.folder(original.id), "frames");
            mkdirSync(frames);
            writeFileSync(join(frames, "frame.jpg"), "frame bytes");
            utimesSync(frames, new Date(at(30)), new Date(at(30)));
            const stateFile = join(store.root, "recorder.json");
            writeFileSync(
                stateFile,
                SafeJSON.stringify({
                    meetingId: status === "recording" ? original.id : "other-meeting",
                    pid: 99999999,
                    startedAt: at(20),
                    display: "all",
                    frames: 1,
                    bytes: 11,
                })
            );
            utimesSync(stateFile, new Date(at(40)), new Date(at(40)));
            const before = readFileSync(store.path(original.id), "utf8");
            const result = await duplicateMeeting({ store, ref: original.id });
            const copy = new MeetingStore(store.storage).read(result.id)!;
            // Only this meeting's heartbeat can extend its last frame's known capture time.
            const ended = at(status === "recording" ? 40 : 30);
            expect(copy.recording).toMatchObject({
                status: "stopped",
                stoppedAt: ended,
                stopReason: "error",
                interrupted: true,
                spans: [
                    { from: at(0), to: at(10) },
                    { from: at(20), to: ended, stopReason: "error", interrupted: true },
                ],
                displaySpans: [
                    { displayId: 1, from: at(0), to: at(10) },
                    { displayId: 2, from: at(20), to: ended, stopReason: "error", interrupted: true },
                ],
            });
            expect(SafeJSON.parse(readFileSync(store.path(result.id), "utf8"))).toMatchObject({
                recording: copy.recording,
            });
            expect(readFileSync(store.path(original.id), "utf8")).toBe(before);
        }
    );

    test("the copy keeps comment and answer history but has no inherited live listener, round or worker lock", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            { title: "Planning", start: "2026-11-05T13:02:36.000Z", createdBy: "new" },
            { command: "test", change: "created" }
        );
        const folder = store.folder(original.id);
        const at = "2026-11-05T13:02:36.000Z";
        const listener = { kind: "listening", listener: { pid: process.pid, at, actor: { kind: "window" } } };
        writeFileSync(join(folder, COMMENTS_FILE), `${SafeJSON.stringify(listener)}\n`);
        appendAnswerEvent(join(folder, ANSWER_LOG_FILE), { event: "round-start", at, pid: process.pid, open: 1 });
        appendAnswerEvent(join(folder, ANSWER_LOG_FILE), { event: "skipped", at, item: "i1" });
        writeFileSync(join(folder, "ocr.pid"), String(process.pid));
        writeFileSync(join(folder, "comments.ndjson.lock"), "live lock");
        const result = await duplicateMeeting({ store, ref: original.id });
        const copy = store.folder(result.id);
        expect(new MeetingComments(join(copy, COMMENTS_FILE), { alive: () => true }).listeners()).toEqual([]);
        expect(roundRunning(join(copy, ANSWER_LOG_FILE), () => true)).toBe(false);
        expect(existsSync(join(copy, "ocr.pid"))).toBe(false);
        expect(existsSync(join(copy, "comments.ndjson.lock"))).toBe(false);
        expect(readAnswerEvents(join(copy, ANSWER_LOG_FILE))).toContainEqual({ event: "skipped", at, item: "i1" });
        expect(new MeetingComments(join(folder, COMMENTS_FILE), { alive: () => true }).listeners()).toHaveLength(1);
        expect(roundRunning(join(folder, ANSWER_LOG_FILE), () => true)).toBe(true);
        expect(readFileSync(join(folder, "ocr.pid"), "utf8")).toBe(String(process.pid));
    });

    test("the copy keeps the fields, items and files, its paths point into its own folder, and the original stays", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            {
                title: "Planning",
                start: "2026-11-05T13:02:36.000Z",
                createdBy: "record",
                project: "work",
                labels: ["Checkout"],
                sources: { wisprflow: { meetingId: "call-1" } },
                exports: [{ path: "/notes/Planning.md", sha256: "abc", at: "2026-11-05T14:00:00.000Z" }],
            },
            { command: "test", change: "created" }
        );
        const framesDir = join(store.folder(original.id), "frames");
        mkdirSync(framesDir, { recursive: true });
        writeFileSync(join(framesDir, "0001.jpg"), "jpg");
        writeFileSync(join(store.folder(original.id), "ScreenOCR.md"), "# Screen words\n");
        await store.update(original.id, { command: "test", change: "frames" }, (record) => {
            record.recording = { framesDir, frames: 1 };
            record.context = [
                { id: "c1", kind: "file", ref: store.folder(original.id), addedAt: record.start, addedBy: "user" },
                {
                    id: "c2",
                    kind: "file",
                    ref: `${store.folder(original.id)}/clips/one.wav`,
                    addedAt: record.start,
                    addedBy: "user",
                },
                {
                    id: "c3",
                    kind: "file",
                    ref: `${store.folder(original.id)}-2/clips/other.wav`,
                    addedAt: record.start,
                    addedBy: "user",
                },
                {
                    id: "c4",
                    kind: "note",
                    ref: `See ${store.folder(original.id)}/frames for context`,
                    addedAt: record.start,
                    addedBy: "user",
                },
            ];
        });

        const result = await duplicateMeeting({ store, ref: original.id });
        const copy = store.read(result.id);

        expect(result.title).toBe("Planning (copy)");
        expect(result.id).not.toBe(original.id);
        expect(copy?.project).toBe("work");
        expect(copy?.labels).toEqual(["Checkout"]);
        expect(copy?.sources).toEqual({ wisprflow: { meetingId: "call-1" } });
        expect(copy?.exports).toBeUndefined();
        expect(copy?.recording?.framesDir).toBe(join(store.folder(result.id), "frames"));
        expect(readFileSync(join(store.folder(result.id), "frames", "0001.jpg"), "utf8")).toBe("jpg");
        expect(readFileSync(join(store.folder(result.id), "ScreenOCR.md"), "utf8")).toBe("# Screen words\n");
        expect(readFileSync(join(store.folder(original.id), "ScreenOCR.md"), "utf8")).toBe("# Screen words\n");
        expect(copy?.history[0]?.change).toBe(`duplicated from ${original.id}`);
        expect(store.read(original.id)?.recording?.framesDir).toBe(framesDir);
        expect(store.read(original.id)?.title).toBe("Planning");
        expect(new MeetingStore(store.storage).read(result.id)?.context.map((entry) => entry.ref)).toEqual([
            store.folder(result.id),
            `${store.folder(result.id)}/clips/one.wav`,
            `${store.folder(original.id)}-2/clips/other.wav`,
            `See ${store.folder(original.id)}/frames for context`,
        ]);
    });

    test("clean copy removes items and journal while preserving source and files", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            {
                title: "Planning",
                start: "2026-11-05T13:02:36.000Z",
                createdBy: "new",
                sources: { wisprflow: { meetingId: "fixture-call" } },
                items: [
                    {
                        id: "i1",
                        kind: "term",
                        status: "suggested",
                        atSec: 1,
                        heard: "zorb",
                        proposed: "ZORB",
                        rules: [],
                        suggestedAt: "2026-11-05T14:00:00.000Z",
                    },
                ],
            },
            { command: "test", change: "created" }
        );
        const journal = new DecisionJournal({ store, ledger: () => {} });
        await journal.apply({
            meeting: original.id,
            actor: { kind: "listen" },
            action: { kind: "confirm", items: ["i1"] },
        });
        writeFileSync(join(store.folder(original.id), "sound.wav"), "sound");
        const framesDir = join(store.folder(original.id), "frames");
        mkdirSync(framesDir);
        writeFileSync(join(framesDir, "0001.jpg"), "frame");
        await store.update(original.id, { command: "test", change: "context" }, (record) => {
            record.recording = { framesDir, frames: 1 };
            record.context = [
                { id: "c1", kind: "note", ref: "Use the glossary", addedAt: record.start, addedBy: "user" },
            ];
        });
        const before = readFileSync(store.path(original.id));
        const journalBefore = readFileSync(journal.path(original.id));
        const request = { store, ref: original.id, withoutItems: true };
        const result = await duplicateMeeting(request);
        const reopened = new MeetingStore(store.storage);
        expect(reopened.read(result.id)?.items).toEqual([]);
        expect(new DecisionJournal({ store: reopened }).read(result.id)).toEqual([]);
        expect(reopened.read(result.id)?.sources).toEqual(original.sources);
        expect(reopened.read(result.id)?.recording?.framesDir).toBe(join(reopened.folder(result.id), "frames"));
        expect(reopened.read(result.id)?.context[0]?.ref).toBe("Use the glossary");
        const { suggestItems } = await import("./suggest");
        const suggestions = suggestItems({
            record: reopened.read(result.id)!,
            meeting: {
                sourceMeetingId: "fixture-call",
                title: "Planning",
                start: original.start,
                participants: [],
                speakers: [],
                folders: [],
                transcript: [
                    { speaker: "Cut", startSec: 10, text: "dot" },
                    { speaker: "Room", startSec: 11, text: "áhnu to do konce." },
                ],
            },
            rules: ["speakers"],
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            now: original.start,
        });
        expect(suggestions.length).toBeGreaterThan(0);
        await reopened.update(result.id, { command: "test suggest", change: "fixture suggestions" }, (record) => {
            record.items.push(...suggestions);
        });
        expect(new MeetingStore(store.storage).read(result.id)?.items).toEqual(suggestions);
        expect(readFileSync(join(reopened.folder(result.id), "frames", "0001.jpg"), "utf8")).toBe("frame");
        expect(readFileSync(join(reopened.folder(result.id), "sound.wav"), "utf8")).toBe("sound");
        expect(readFileSync(store.path(original.id))).toEqual(before);
        expect(readFileSync(journal.path(original.id))).toEqual(journalBefore);
    });

    test("copied journal names the copy and Undo leaves the original bytes unchanged", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            {
                title: "Planning",
                start: "2026-11-05T13:02:36.000Z",
                createdBy: "new",
                items: [
                    {
                        id: "i1",
                        kind: "term",
                        status: "suggested",
                        atSec: 1,
                        heard: "zorb",
                        proposed: "ZORB",
                        rules: [],
                        suggestedAt: "2026-11-05T14:00:00.000Z",
                    },
                ],
            },
            { command: "test", change: "created" }
        );
        const ledger: Correction[] = [];
        const journal = new DecisionJournal({ store, ledger: (lines) => ledger.push(...lines) });
        const decision = await journal.apply({
            meeting: original.id,
            actor: { kind: "listen" },
            action: { kind: "confirm", items: ["i1"] },
        });
        const before = readFileSync(store.path(original.id));
        const journalBefore = readFileSync(journal.path(original.id));
        const result = await duplicateMeeting({ store, ref: original.id });
        const reopened = new MeetingStore(store.storage);
        const copied = new DecisionJournal({ store: reopened, ledger: (lines) => ledger.push(...lines) });
        const entry = copied.read(result.id)[0]!;
        expect(entry.meeting).toBe(result.id);
        expect(entry.copiedFrom).toBe(original.id);
        expect(entry.corrections.length).toBeGreaterThan(0);
        expect(entry.corrections.every((line) => line.meeting === result.id)).toBe(true);
        expect(SafeJSON.parse(readFileSync(join(reopened.folder(result.id), JOURNAL_FILE), "utf8"))).toMatchObject({
            copiedFrom: original.id,
        });
        expect(entry.token).toBe(decision.entry!.token);
        await copied.revert({ meeting: result.id, token: entry.token, actor: { kind: "listen" } });
        expect(new MeetingStore(store.storage).read(result.id)?.items[0]?.status).toBe("suggested");
        expect(ledger.filter((line) => line.retracted).every((line) => line.meeting === result.id)).toBe(true);
        expect(readFileSync(store.path(original.id))).toEqual(before);
        expect(readFileSync(journal.path(original.id))).toEqual(journalBefore);
    });

    test("incompatible foreign journals refuse copy and Undo without publishing or changing the original", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            { title: "Planning", start: "2026-11-05T13:02:36.000Z", createdBy: "new" },
            { command: "test", change: "created" }
        );
        const journal = new DecisionJournal({ store, ledger: () => {} });
        const entry = (
            await journal.apply({
                meeting: original.id,
                actor: { kind: "listen" },
                action: { kind: "set", title: "Revised planning" },
            })
        ).entry!;
        writeFileSync(journal.path(original.id), `${SafeJSON.stringify({ ...entry, meeting: "another-meeting" })}\n`);
        const before = readFileSync(store.path(original.id));
        const journalBefore = readFileSync(journal.path(original.id));
        expect(journal.read(original.id)[0]?.meeting).toBe("another-meeting");
        await expect(duplicateMeeting({ store, ref: original.id })).rejects.toThrow("incompatible journal");
        await expect(
            journal.revert({ meeting: original.id, token: entry.token, actor: { kind: "listen" } })
        ).rejects.toThrow("refusing cross-record Undo");
        expect(store.list().map((record) => record.id)).toEqual([original.id]);
        expect(readFileSync(store.path(original.id))).toEqual(before);
        expect(readFileSync(journal.path(original.id))).toEqual(journalBefore);
        const clean = await duplicateMeeting({ store, ref: original.id, withoutItems: true });
        expect(new DecisionJournal({ store: new MeetingStore(store.storage) }).read(clean.id)).toEqual([]);
    });

    test("CLI clean-copy spellings use the common duplicate path", async () => {
        const { Command } = await import("commander");
        const { registerMeetingCommands } = await import("../commands/meeting");
        const { out } = await import("@genesiscz/utils/logger");
        const store = new MeetingStore();
        const original = await store.create(
            {
                title: "CLI planning",
                start: "2026-11-05T13:02:36.000Z",
                createdBy: "new",
                items: [
                    {
                        id: "i1",
                        kind: "term",
                        status: "suggested",
                        atSec: 1,
                        heard: "zorb",
                        rules: [],
                        suggestedAt: "2026-11-05T14:00:00.000Z",
                    },
                ],
            },
            { command: "test", change: "created" }
        );
        const printed = spyOn(out, "result").mockImplementation(() => {});
        try {
            for (const flag of ["--without-items", "--no-items"]) {
                const program = new Command();
                registerMeetingCommands(program);
                await program.parseAsync(["duplicate", original.id, flag, "--title", `CLI ${flag}`, "--json"], {
                    from: "user",
                });
                const result = meetingRecordSchema
                    .pick({ id: true })
                    .parse(SafeJSON.parse(String(printed.mock.calls.at(-1)![0])));
                const copy = new MeetingStore(store.storage).read(result.id)!;
                expect(copy.items).toEqual([]);
                expect(copy.title).toBe(`CLI ${flag}`);
                expect(copy.history[0]?.change).toBe(`duplicated from ${original.id} without items`);
            }
        } finally {
            printed.mockRestore();
        }
    });

    test("a given title wins, and an untitled meeting's copy has a name", async () => {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-duplicate-${process.pid}-${stores}`));
        const original = await store.create(
            { title: "Planning", start: "2026-11-05T13:02:36.000Z", createdBy: "new" },
            { command: "test", change: "created" }
        );

        const result = await duplicateMeeting({ store, ref: original.id, title: "Planning B" });
        expect(result.title).toBe("Planning B");
        const reopened = new MeetingStore(store.storage).read(result.id)!;
        expect(reopened.history).toHaveLength(1);
        expect(reopened.history[0]?.change).toBe(`duplicated from ${original.id}`);
        expect(copyTitle("  ")).toBe("Untitled meeting (copy)");
    });
});

describe("permanent source audio", () => {
    async function fixture() {
        stores += 1;
        const store = new MeetingStore(new Storage(`source-audio-${process.pid}-${stores}`));
        const record = await store.create(
            {
                title: "Planning",
                start: "2026-11-12T14:00:00.000Z",
                createdBy: "new",
                sources: { wisprflow: { meetingId: "source-one" } },
            },
            { command: "test", change: "source audio fixture" }
        );
        const sourcePath = join(store.root, "source.ogg");
        writeFileSync(sourcePath, "source audio bytes", { mode: 0o600 });
        const options = {
            store,
            meetingId: record.id,
            ref: { sourceId: "wisprflow", sourceMeetingId: "source-one" },
            sourcePath,
        };
        return { store, record, sourcePath, options, folder: join(store.folder(record.id), SOURCE_AUDIO_FOLDER) };
    }

    test("publishes private verified audio and persists its metadata after reopening", async () => {
        const f = await fixture();
        const result = await preserveSourceAudio(f.options);
        expect(result.status).toBe("preserved");
        expect(result.audio).toMatchObject({
            sourceMeetingId: "source-one",
            bytes: 18,
            sha256: createHash("sha256").update("source audio bytes").digest("hex"),
        });
        expect(readFileSync(result.audio.path, "utf8")).toBe("source audio bytes");
        expect(statSync(result.audio.path).mode & 0o777).toBe(0o600);
        expect(statSync(f.folder).mode & 0o777).toBe(0o700);
        const reopened = new MeetingStore(f.store.storage).read(f.record.id)!;
        expect(reopened.audio?.sources.wisprflow).toEqual(result.audio);
        expect(SafeJSON.parse(readFileSync(f.store.path(f.record.id), "utf8"))).toHaveProperty(
            "audio.sources.wisprflow",
            result.audio
        );
        expect(readFileSync(f.sourcePath, "utf8")).toBe("source audio bytes");
        expect(readdirSync(f.folder)).toEqual([`${result.audio.sha256}.ogg`]);
        expect(showText(reopened)).toContain(`SHA256 ${result.audio.sha256}`);
        expect(meetingListRowSchema.parse(meetingListRow(reopened)).sourceAudio).toEqual({
            sources: ["wisprflow"],
            bytes: 18,
        });
    });

    test("a repeated preservation writes no second history entry and lookup survives the provider file moving away", async () => {
        const f = await fixture();
        const first = await preserveSourceAudio(f.options);
        const bytes = readFileSync(f.store.path(f.record.id), "utf8");
        const second = await preserveSourceAudio(f.options);
        expect(second.status).toBe("already-preserved");
        expect(readFileSync(f.store.path(f.record.id), "utf8")).toBe(bytes);
        renameSync(f.sourcePath, `${f.sourcePath}.aside`);
        const reopened = new MeetingStore(f.store.storage).read(f.record.id)!;
        expect(preservedSourceAudio(reopened)).toEqual(first.audio);
        expect(readFileSync(preservedSourceAudio(reopened)!.path, "utf8")).toBe("source audio bytes");
    });

    test("a volume that cannot clone uses a private complete copy", async () => {
        const f = await fixture();
        const clone = spyOn(cloneFiles, "cloneOrCopy").mockReturnValue("declined");
        try {
            const result = await preserveSourceAudio(f.options);
            expect(result.placement).toBe("copied");
            expect(readFileSync(result.audio.path, "utf8")).toBe("source audio bytes");
            expect(statSync(result.audio.path).mode & 0o777).toBe(0o600);
        } finally {
            clone.mockRestore();
        }
    });

    test("a source still changing leaves no metadata or scratch, and a later stable retry succeeds", async () => {
        const f = await fixture();
        const originalHash = hashFiles.sha256FileAsync;
        let changed = false;
        const hash = spyOn(hashFiles, "sha256FileAsync").mockImplementation(async (...args) => {
            const digest = await originalHash(...args);
            if (!changed) {
                appendFileSync(f.sourcePath, " more");
                changed = true;
            }
            return digest;
        });
        try {
            await expect(preserveSourceAudio(f.options)).rejects.toThrow("Source audio changed");
        } finally {
            hash.mockRestore();
        }
        expect(new MeetingStore(f.store.storage).read(f.record.id)?.audio).toBeUndefined();
        expect(readdirSync(f.folder)).toEqual([]);
        const result = await preserveSourceAudio(f.options);
        expect(result.audio.bytes).toBe(23);
        expect(readFileSync(result.audio.path, "utf8")).toBe("source audio bytes more");
    });

    test("a failed metadata write retains the verified file and a retry publishes it once", async () => {
        const f = await fixture();
        const before = readFileSync(f.store.path(f.record.id), "utf8");
        const originalWrite = atomicFile.atomicWriteFileSync;
        const write = spyOn(atomicFile, "atomicWriteFileSync").mockImplementation((file, data, options) => {
            if (file === f.store.path(f.record.id)) {
                throw new Error("ENOSPC: fixture metadata write failed");
            }
            originalWrite(file, data, options);
        });
        try {
            await expect(preserveSourceAudio(f.options)).rejects.toThrow("ENOSPC");
        } finally {
            write.mockRestore();
        }
        expect(readFileSync(f.store.path(f.record.id), "utf8")).toBe(before);
        const kept = readdirSync(f.folder);
        expect(kept).toHaveLength(1);
        expect(readFileSync(join(f.folder, kept[0]!), "utf8")).toBe("source audio bytes");
        const result = await preserveSourceAudio(f.options);
        expect(result.audio.path).toBe(join(f.folder, kept[0]!));
        expect(readdirSync(f.folder)).toEqual(kept);
        expect(
            new MeetingStore(f.store.storage)
                .read(f.record.id)
                ?.history.filter((entry) => entry.command === "audio preserve")
        ).toHaveLength(1);
    });

    test("concurrent callers publish one content file and one metadata history entry", async () => {
        const f = await fixture();
        const results = await Promise.all([preserveSourceAudio(f.options), preserveSourceAudio(f.options)]);
        expect(results.map((result) => result.status).sort()).toEqual(["already-preserved", "preserved"]);
        expect(results[0]!.audio).toEqual(results[1]!.audio);
        expect(readdirSync(f.folder)).toHaveLength(1);
        expect(
            new MeetingStore(f.store.storage)
                .read(f.record.id)
                ?.history.filter((entry) => entry.command === "audio preserve")
        ).toHaveLength(1);
    });

    test("a relink while hashing refuses metadata for the previous source", async () => {
        const f = await fixture();
        const originalHash = hashFiles.sha256FileAsync;
        const hash = spyOn(hashFiles, "sha256FileAsync").mockImplementation(async (...args) => {
            const digest = await originalHash(...args);
            await f.store.update(f.record.id, { command: "test", change: "relink" }, (record) => {
                record.sources.wisprflow = { meetingId: "source-two" };
            });
            return digest;
        });
        try {
            await expect(preserveSourceAudio(f.options)).rejects.toThrow("linked source changed");
        } finally {
            hash.mockRestore();
        }
        const reopened = new MeetingStore(f.store.storage).read(f.record.id)!;
        expect(reopened.audio).toBeUndefined();
        expect(preservedSourceAudio(reopened)).toBeUndefined();
        expect(readdirSync(f.folder)).toHaveLength(1);
        expect(readFileSync(f.sourcePath, "utf8")).toBe("source audio bytes");
    });

    test("a conflicting existing digest file is never overwritten", async () => {
        const f = await fixture();
        mkdirSync(f.folder, { mode: 0o700 });
        const digest = createHash("sha256").update("source audio bytes").digest("hex");
        const conflicting = join(f.folder, `${digest}.ogg`);
        writeFileSync(conflicting, "existing bytes");
        await expect(preserveSourceAudio(f.options)).rejects.toThrow("does not match its digest");
        expect(readFileSync(conflicting, "utf8")).toBe("existing bytes");
        expect(new MeetingStore(f.store.storage).read(f.record.id)?.audio).toBeUndefined();
        expect(readdirSync(f.folder)).toEqual([`${digest}.ogg`]);
    });

    test("lifecycle preservation retries a missing file and prefers its owned copy after the provider removes it", async () => {
        const f = await fixture();
        renameSync(f.sourcePath, `${f.sourcePath}.aside`);
        const source = {
            ...wisprflowSource,
            evidence: async () => ({ audioPath: f.sourcePath, segments: [], speaking: [], files: [] }),
        };
        const options = { store: f.store, record: f.record, source, sourceMeetingId: "source-one" };
        expect((await syncSourceAudio(options)).status).toBe("missing");
        expect(new MeetingStore(f.store.storage).read(f.record.id)?.audio).toBeUndefined();
        renameSync(`${f.sourcePath}.aside`, f.sourcePath);
        const saved = await syncSourceAudio(options);
        expect(saved.status).toBe("preserved");
        renameSync(f.sourcePath, `${f.sourcePath}.gone`);
        const reopened = new MeetingStore(f.store.storage).read(f.record.id)!;
        expect((await syncSourceAudio({ ...options, record: reopened })).status).toBe("already-preserved");
        const evidence = withPreservedSourceAudio(reopened, null);
        expect(evidence?.audioPath).toBe(preservedSourceAudio(reopened)?.path);
        expect(readFileSync(evidence!.audioPath!, "utf8")).toBe("source audio bytes");
    });

    test("a stopgap file is preserved without changing it when the provider has already deleted its copy", async () => {
        const f = await fixture();
        const sourceMeetingId = `legacy-${process.pid}-${stores}`;
        const record = await f.store.update(f.record.id, { command: "test", change: "legacy source" }, (current) => {
            current.sources.wisprflow = { meetingId: sourceMeetingId };
        });
        const legacy = join(dirname(f.store.root), "meetings-audio-archive", sourceMeetingId, "upload.ogg");
        mkdirSync(dirname(legacy), { recursive: true });
        writeFileSync(legacy, "legacy full audio");
        const source = { ...wisprflowSource, evidence: async () => null };
        const saved = await syncSourceAudio({ store: f.store, record, source, sourceMeetingId });
        expect(saved.status).toBe("preserved");
        expect(readFileSync(preservedSourceAudio(saved.record)!.path, "utf8")).toBe("legacy full audio");
        expect(readFileSync(legacy, "utf8")).toBe("legacy full audio");
    });

    test("duplicate retains its own audio and metadata without changing the original", async () => {
        const f = await fixture();
        const saved = await preserveSourceAudio(f.options);
        const result = await duplicateMeeting({ store: f.store, ref: f.record.id });
        const copied = new MeetingStore(f.store.storage).read(result.id)!;
        const audio = preservedSourceAudio(copied)!;
        expect(audio.path.startsWith(`${f.store.folder(result.id)}/source-audio/`)).toBe(true);
        expect(audio.sha256).toBe(saved.audio.sha256);
        expect(readFileSync(audio.path, "utf8")).toBe("source audio bytes");
        expect(preservedSourceAudio(new MeetingStore(f.store.storage).read(f.record.id)!)?.path).toBe(saved.audio.path);
        expect(readFileSync(saved.audio.path, "utf8")).toBe("source audio bytes");
    });

    test("an aborted preservation does not create a media folder", async () => {
        const f = await fixture();
        const controller = new AbortController();
        controller.abort(new Error("fixture cancellation"));
        await expect(preserveSourceAudio({ ...f.options, signal: controller.signal })).rejects.toThrow(
            "fixture cancellation"
        );
        expect(existsSync(f.folder)).toBe(false);
        expect(readFileSync(f.sourcePath, "utf8")).toBe("source audio bytes");
    });
});

test("an already linked source warns with the duplicate command instead of claiming a new record", async () => {
    const { Command } = await import("commander");
    const { ui } = await import("@genesiscz/utils/cli/ui");
    const { registerMeetingCommands } = await import("../commands/meeting");
    const links = await import("./link");
    const collection = await import("./collect");
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Linked fixture",
            start: "2026-11-05T10:00:00Z",
            createdBy: "new",
            sources: { wisprflow: { meetingId: "held-source-fixture" } },
        },
        { command: "fixture", change: "created" }
    );
    const before = readFileSync(store.path(record.id));
    const link = spyOn(links, "linkSource").mockResolvedValue({ record, created: false });
    const collect = spyOn(collection, "collectAndReport").mockResolvedValue(record);
    const warning = spyOn(ui, "warn").mockImplementation(() => {});
    const ok = spyOn(ui, "ok").mockImplementation(() => {});
    try {
        const program = new Command().exitOverride();
        registerMeetingCommands(program);
        await program.parseAsync(["new", "--source", "wisprflow:held-source-fixture", "--yes"], { from: "user" });
        expect(warning).toHaveBeenCalledWith(expect.stringContaining(`duplicate ${record.id}`));
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("--without-items"));
        expect(ok).not.toHaveBeenCalled();
        expect(readFileSync(store.path(record.id))).toEqual(before);
    } finally {
        link.mockRestore();
        collect.mockRestore();
        warning.mockRestore();
        ok.mockRestore();
    }
});
