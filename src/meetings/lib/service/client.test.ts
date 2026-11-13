import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { MEETING_FILE, MeetingStore } from "@genesiscz/utils/meetings/record";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import { Storage } from "@genesiscz/utils/storage/storage";
import { MEETINGS_PROTOCOL, type MeetingsEvent, type MeetingsHello } from "./api";
import { InProcessMeetingsClient } from "./client";

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
});
