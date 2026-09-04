import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "../../../config/schema";
import type { CodexUsageClient } from "./usage";
import { codexHomeFor, mapRateLimits, pollCodexAccount } from "./usage";

/**
 * The app-server is never spawned here. `openClient` is injected, which is also how the
 * `close()` contract is asserted: a poll that leaves the child running costs one process
 * per account per tick, forever, because the daemon never stops polling.
 */

function entry(name: string, credentials: AccountEntry["credentials"] = {}): AccountEntry {
    return { id: `acc_${name}`, name, provider: "openai-sub", credentials } as AccountEntry;
}

interface FakeClient extends CodexUsageClient {
    closed: number;
    methods: string[];
}

function fakeClient(result: unknown, opts: { throwOn?: string } = {}): FakeClient {
    const client: FakeClient = {
        closed: 0,
        methods: [],
        async request<T>(method: string): Promise<T> {
            client.methods.push(method);

            if (opts.throwOn === method) {
                throw new Error(`boom in ${method}`);
            }

            return result as T;
        },
        async notify() {},
        async close() {
            client.closed += 1;
        },
    };

    return client;
}

const CAMEL = {
    rateLimits: {
        primary: { usedPercent: 41.5, windowDurationMins: 300, resetsAt: 1_757_000_000 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_757_400_000 },
        planType: "plus",
    },
};

const SNAKE = {
    rate_limits: {
        primary: { used_percent: 41.5, window_duration_mins: 300, resets_at: 1_757_000_000 },
        secondary: { used_percent: 12, window_duration_mins: 10_080, resets_at: 1_757_400_000 },
        plan_type: "plus",
    },
};

describe("mapRateLimits", () => {
    it("reads the camelCase spelling the live app-server sends", () => {
        const { limits, planName } = mapRateLimits(CAMEL);

        expect(planName).toBe("plus");
        expect(limits).toEqual([
            {
                key: "primary",
                label: "Session",
                kind: "session",
                percentUsed: 41.5,
                periodMs: 300 * 60_000,
                resetsAt: new Date(1_757_000_000 * 1000).toISOString(),
            },
            {
                key: "secondary",
                label: "Weekly",
                kind: "weekly",
                percentUsed: 12,
                periodMs: 10_080 * 60_000,
                resetsAt: new Date(1_757_400_000 * 1000).toISOString(),
            },
        ]);
    });

    // The protocol is unversioned, so both spellings are accepted rather than guessed at.
    it("reads the snake_case spelling identically", () => {
        expect(mapRateLimits(SNAKE)).toEqual(mapRateLimits(CAMEL));
    });

    it("returns nothing when the payload carries no rate limits", () => {
        expect(mapRateLimits({}).limits).toEqual([]);
        expect(mapRateLimits(null).limits).toEqual([]);
    });
});

describe("codexHomeFor", () => {
    it("takes the directory holding the account's auth file", () => {
        expect(codexHomeFor(entry("work", { authFile: "/tmp/.codex-work/auth.json" }))).toBe("/tmp/.codex-work");
    });

    it("falls back to dataDir, then to the CLI default", () => {
        expect(codexHomeFor(entry("work", { dataDir: "/tmp/.codex-alt" }))).toBe("/tmp/.codex-alt");
        expect(codexHomeFor(entry("work"))).toBe(join(homedir(), ".codex"));
    });
});

describe("openai-sub usage.poll", () => {
    it("maps a live read into a snapshot and closes the app-server", async () => {
        const client = fakeClient(CAMEL);

        const snapshot = await pollCodexAccount(entry("work"), {}, { openClient: async () => client });

        expect(snapshot).toMatchObject({ provider: "openai-sub", accountId: "acc_work", plan: { name: "plus" } });
        expect(snapshot.limits.map((w) => w.key)).toEqual(["primary", "secondary"]);
        expect(client.methods).toEqual(["account/rateLimits/read"]);
        expect(client.closed).toBe(1);
    });

    it("closes the app-server when the request throws", async () => {
        const client = fakeClient(CAMEL, { throwOn: "account/rateLimits/read" });

        await expect(pollCodexAccount(entry("work"), {}, { openClient: async () => client })).rejects.toThrow("boom");

        expect(client.closed).toBe(1);
    });

    it("reports a home with no login instead of throwing", async () => {
        const client = fakeClient({});

        const snapshot = await pollCodexAccount(entry("side"), {}, { openClient: async () => client });

        expect(snapshot.limits).toEqual([]);
        expect(snapshot.error).toContain("no rate limits");
        expect(snapshot.auth?.reason).toBe("not logged in");
        expect(client.closed).toBe(1);
    });
});
