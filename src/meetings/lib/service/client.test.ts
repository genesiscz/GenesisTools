import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatcherOptions } from "@genesiscz/utils/fs/watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { MEETING_FILE, MeetingStore } from "@genesiscz/utils/meetings/record";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import { Storage } from "@genesiscz/utils/storage/storage";
import { MEETINGS_PROTOCOL, type MeetingsEvent, type MeetingsHello } from "./api";
import {
    InProcessMeetingsClient,
    localMeetingsEvents,
    type MeetingsEventMessage,
    SocketMeetingsClient,
} from "./client";
import { startMeetingsService } from "./service";

const CODE = "0123456789ab";
const hello: MeetingsHello = { role: "cli", protocol: MEETINGS_PROTOCOL, code: CODE, pid: 4242 };
/** One invented meeting, written as a file. */
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

const closing: Array<() => void> = [];

afterEach(() => {
    for (const close of closing.splice(0).reverse()) {
        close();
    }
});

let stores = 0;

function scratchStore(): MeetingStore {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-client-${process.pid}-${stores}`));
    mkdirSync(store.folder(RETRO.id), { recursive: true });
    writeFileSync(join(store.folder(RETRO.id), MEETING_FILE), SafeJSON.stringify(RETRO, null, 2));
    return store;
}

/** A stand-in for @parcel/watcher: `raise` hands the folder watch the events a write of these paths would raise. */
function fakeFolderEvents(): { subscribe: NonNullable<WatcherOptions["subscribe"]>; raise: (path: string) => void } {
    let deliver: ((path: string) => void) | undefined;
    return {
        subscribe: async (_dir, callback) => {
            deliver = (path) => callback(null, [{ type: "update", path }]);
            return { unsubscribe: async () => {} };
        },
        raise: (path) => deliver?.(path),
    };
}

/** A service of the tests' code in `dir`; `subscribe` fakes its folder watch. */
async function startService(dir: string, subscribe?: NonNullable<WatcherOptions["subscribe"]>) {
    const store = scratchStore();
    const start = await startMeetingsService({
        dir,
        store: () => store,
        linkedSource: () => undefined,
        idleMs: 0,
        code: CODE,
        watch: subscribe ? { subscribe, coalesceMs: 0 } : false,
    });

    if (start.status !== "started") {
        throw new Error("the meetings service did not start");
    }

    closing.push(() => start.service.stop("test end"));
    return { service: start.service, store };
}

/** The events a listener hears: `next` waits for the next one (2 s at most). */
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
    };
}

/** True once `check` holds; false when it still does not after 2 s. */
async function eventually(check: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 2000;

    while (!check()) {
        if (Date.now() >= deadline) {
            return false;
        }

        await Bun.sleep(20);
    }

    return true;
}

async function failure(promise: Promise<unknown>): Promise<Error> {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
    }

    throw new Error("the call did not fail");
}

describe("meetings clients", () => {
    test("a subscribe whose events is not a list is refused as invalid params, never read as its characters", async () => {
        const client = new InProcessMeetingsClient({ hello });
        closing.push(() => client.close());
        // Values a caller outside TypeScript can send (the REPL, a JSON line).
        const filters: Array<{ events?: readonly MeetingsEvent[] }> = SafeJSON.parse(
            '[{ "events": "meeting.changed" }, { "events": 5 }]',
            { strict: true }
        );

        for (const filter of filters) {
            const refused = await failure(client.subscribe(filter, () => {}));
            expect(refused).toBeInstanceOf(RpcError);
            expect(refused instanceof RpcError ? refused.code : undefined).toBe(JSON_RPC_ERRORS.invalidParams);
        }
    });

    test("an in-process call with a cancelled signal stops before any handler runs", async () => {
        const store = scratchStore();
        const client = new InProcessMeetingsClient({ hello, deps: { store: () => store } });
        closing.push(() => client.close());
        const before = store.read(RETRO.id);

        const refused = await failure(
            client.call(
                "decision.apply",
                { meeting: RETRO.id, action: { kind: "confirm", items: ["i1"] } },
                { signal: AbortSignal.abort() }
            )
        );

        expect(refused.message).toBe("decision.apply: cancelled");
        expect(store.read(RETRO.id)).toEqual(before);
    });

    test("after the service went, a call reaches a new service of the same code and the listeners hear it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mtg-"));
        const first = await startService(dir);
        const client = await SocketMeetingsClient.connect(first.service.entry, hello);
        closing.push(() => client.close());
        const heard = eventQueue();
        await client.subscribe({ events: ["comment.changed"] }, heard.push);
        first.service.stop("test: restarted");
        await first.service.stopped;

        const folder = fakeFolderEvents();
        const second = await startService(dir, folder.subscribe);
        // The new service answers from its store; this process's own store (the sandbox home's) holds no meeting.
        expect((await client.call("meetings.list", { limit: 1 })).map((row) => row.id)).toEqual([RETRO.id]);
        expect(second.service.callers().map((caller) => caller.pid)).toEqual([hello.pid]);

        folder.raise(join(second.store.folder(RETRO.id), "comments.ndjson"));
        expect(await heard.next()).toEqual({ method: "comment.changed", params: { meeting: RETRO.id } });
    });

    test("calls that find the connection closed together share one new connection", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mtg-"));
        const first = await startService(dir);
        const client = await SocketMeetingsClient.connect(first.service.entry, hello);
        closing.push(() => client.close());
        first.service.stop("test: restarted");
        await first.service.stopped;

        const second = await startService(dir);
        const answers = await Promise.all([
            client.call("meetings.list", { limit: 1 }),
            client.call("meetings.list", { limit: 1 }),
            client.subscribe({ events: ["comment.changed"] }, () => {}),
        ]);

        expect(answers[0].map((row) => row.id)).toEqual([RETRO.id]);
        expect(second.service.callers()).toHaveLength(1);
    });

    test("a close while the client connects again leaves no connection to the new service open", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mtg-"));
        const first = await startService(dir);
        const client = await SocketMeetingsClient.connect(first.service.entry, hello);
        first.service.stop("test: restarted");
        await first.service.stopped;

        const second = await startService(dir);
        // The call finds the connection closed and waits for the new hello; close() runs in that wait.
        const pending = client.call("meetings.list", { limit: 1 });
        client.close();
        await pending;

        expect(await eventually(() => second.service.callers().length === 0)).toBe(true);
    });

    test("with no service, a write is refused while the process it spoke to still runs; a read answers in-process", async () => {
        const dir = mkdtempSync(join(tmpdir(), "mtg-"));
        const { service } = await startService(dir);
        // The entry as another process's service would write it: a pid that still runs (this test's parent).
        const client = await SocketMeetingsClient.connect(
            { ...service.entry, pid: process.ppid, pidCommand: undefined },
            hello
        );
        closing.push(() => client.close());
        const heard = eventQueue();
        await client.subscribe({ events: ["people.changed"] }, heard.push);
        service.stop("test: gone");
        await service.stopped;

        expect(await client.call("meetings.list", { project: "Atlas" })).toEqual([]);
        const refused = await failure(
            client.call("decision.apply", { meeting: RETRO.id, action: { kind: "confirm", items: ["i1"] } })
        );
        expect(refused.message).toBe(
            "decision.apply: the meetings service closed this connection but has not exited yet; nothing was changed, try again"
        );

        // The in-process adapter emits on this process's bus, and the listeners hear it there.
        localMeetingsEvents.emit("people.changed", {});
        expect(await heard.next()).toEqual({ method: "people.changed", params: {} });
    });
});
