import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkGate } from "@genesiscz/utils/browser-router/link-gate";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { AssignInbox } from "./assign-inbox";
import { applySource, assertSourceFree, playLinksFor, sourceHolders } from "./link";
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
