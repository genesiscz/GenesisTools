import { describe, expect, spyOn, test } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { LinkGate } from "@genesiscz/utils/browser-router/link-gate";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import * as atomicFile from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { ANSWER_LOG_FILE, appendAnswerEvent, readAnswerEvents, roundRunning } from "./answer-log";
import type { AssignInbox } from "./assign-inbox";
import { COMMENTS_FILE, MeetingComments } from "./comments";
import { copyTitle, duplicateMeeting } from "./duplicate";
import { applySource, assertSourceFree, playLinksFor, sourceHolders } from "./link";
import * as mergeFiles from "./merge";
import { mergeMeetings } from "./merge";

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
        const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
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
            expect(new MeetingStore(store.storage).list().map((record) => record.id)).toEqual([original.id]);
            expect(readFileSync(store.path(original.id), "utf8")).toBe(recordBefore);
            expect(readFileSync(join(store.folder(original.id), "capture.txt"), "utf8")).toBe("original bytes");
        } finally {
            clone.mockRestore();
        }
    });

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
