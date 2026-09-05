import { describe, expect, mock, test } from "bun:test";
import type { AccountEntry } from "../../../config/schema";

/**
 * The default `spawnClient` path, which the injected-client tests in `usage.test.ts`
 * never reach. A handshake that fails leaves a live `codex app-server` child unless the
 * client is closed on the way out, and the daemon retries every poll.
 */

let closes = 0;
let constructed = 0;
let failHandshake = true;

class FakeAppServerClient {
    constructor(_process: unknown) {
        constructed += 1;
    }

    async request<T>(_method: string): Promise<T> {
        if (failHandshake) {
            throw new Error("initialize refused");
        }

        return {} as T;
    }

    async notify(): Promise<void> {}

    async close(): Promise<void> {
        closes += 1;
    }
}

mock.module("../../../openai/app-server-client", () => ({
    AppServerClient: FakeAppServerClient,
    spawnAppServer: () => ({ pid: 1 }),
}));

const { pollCodexAccount } = await import("./usage");

const ACCOUNT = { id: "acc_work", name: "work", provider: "openai-sub", credentials: {} } as AccountEntry;

describe("spawnClient handshake", () => {
    test("closes the client when the handshake fails", async () => {
        closes = 0;
        constructed = 0;
        failHandshake = true;

        await expect(pollCodexAccount(ACCOUNT)).rejects.toThrow("initialize refused");
        expect(constructed).toBe(1);
        expect(closes).toBe(1);
    });

    // Negative control: a handshake that succeeds still closes exactly once, from the
    // poll's own `finally`, rather than twice.
    test("a successful handshake closes exactly once", async () => {
        closes = 0;
        failHandshake = false;

        const snapshot = await pollCodexAccount(ACCOUNT);

        expect(snapshot.error).toBe("codex app-server reported no rate limits");
        expect(closes).toBe(1);
    });
});
