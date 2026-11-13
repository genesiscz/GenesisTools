import { afterEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { JSON_RPC_ERRORS, RpcError } from "@genesiscz/utils/rpc/errors";
import { MEETINGS_PROTOCOL, type MeetingsEvent, type MeetingsHello } from "./api";
import { InProcessMeetingsClient } from "./client";

const CODE = "0123456789ab";
const hello: MeetingsHello = { role: "cli", protocol: MEETINGS_PROTOCOL, code: CODE, pid: 4242 };
const closing: Array<() => void> = [];

afterEach(() => {
    for (const close of closing.splice(0).reverse()) {
        close();
    }
});

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
});
