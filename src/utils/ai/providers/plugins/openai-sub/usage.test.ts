import { describe, expect, it } from "bun:test";
import { isTransportFailure } from "@genesiscz/utils/ai/usage-poll/poll-gate";
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

/** An account bound to a home, which is what every poll below needs to reach a client. */
function bound(name: string): AccountEntry {
    return entry(name, { dataDir: `/tmp/.codex-${name}` });
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

    it("drops the placeholder resetsAt of an untouched (0%) window", () => {
        const { limits } = mapRateLimits({
            rateLimits: {
                primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_757_000_000 },
                secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_757_400_000 },
            },
        });

        expect(limits[0]).toEqual({
            key: "primary",
            label: "Session",
            kind: "session",
            percentUsed: 0,
            periodMs: 300 * 60_000,
        });
        expect(limits[1]?.resetsAt).toBe(new Date(1_757_400_000 * 1000).toISOString());
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

    it("falls back to dataDir", () => {
        expect(codexHomeFor(entry("work", { dataDir: "/tmp/.codex-alt" }))).toBe("/tmp/.codex-alt");
    });

    /**
     * An account may hold its own tokens with no home. Answering `~/.codex` filed a
     * different login's rate limits under this account's id and name, and gave every such
     * account the same numbers (review t9).
     */
    it("never falls back to the CLI default home", () => {
        expect(codexHomeFor(entry("work"))).toBeNull();
        expect(codexHomeFor(entry("personal", { accessToken: "at", refreshToken: "rt" }))).toBeNull();
    });
});

describe("openai-sub usage.poll", () => {
    // The whole point of t9: an unbound account must not read someone else's home, and it
    // must not spawn an app-server to find that out either.
    it("reports an unbound account instead of polling the CLI default home", async () => {
        let opened = 0;
        const snapshot = await pollCodexAccount(
            entry("personal"),
            {},
            {
                openClient: async () => {
                    opened += 1;
                    return fakeClient(CAMEL);
                },
            }
        );

        expect(opened).toBe(0);
        expect(snapshot.limits).toEqual([]);
        expect(snapshot.error).toContain("no Codex home bound");
        expect(snapshot.accountName).toBe("personal");
    });

    it("maps a live read into a snapshot and closes the app-server", async () => {
        const client = fakeClient(CAMEL);

        const snapshot = await pollCodexAccount(bound("work"), {}, { openClient: async () => client });

        expect(snapshot).toMatchObject({ provider: "openai-sub", accountId: "acc_work", plan: { name: "plus" } });
        expect(snapshot.limits.map((w) => w.key)).toEqual(["primary", "secondary"]);
        expect(client.methods).toEqual(["account/rateLimits/read"]);
        expect(client.closed).toBe(1);
    });

    it("closes the app-server when the request throws", async () => {
        const client = fakeClient(CAMEL, { throwOn: "account/rateLimits/read" });

        await expect(pollCodexAccount(bound("work"), {}, { openClient: async () => client })).rejects.toThrow("boom");

        expect(client.closed).toBe(1);
    });

    // A bare `ENOENT ... posix_spawn 'codex'` used to reach the dashboard card verbatim.
    it("says what to do when the app-server cannot be started at all", async () => {
        const spawnFailure = Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'codex'"), {
            code: "ENOENT",
        });

        await expect(
            pollCodexAccount(bound("work"), {}, { openClient: () => Promise.reject(spawnFailure) })
        ).rejects.toThrow(/Codex CLI is installed.*codex login/s);
    });

    // The wrapper must not hide a handshake deadline from the poll gate, or a slow spawn
    // would ratchet the account ladder instead of the five-minute transport one.
    it("keeps the underlying error as the cause", async () => {
        const deadline = new Error("codex app-server initialize timed out after 10000ms");

        const caught = await pollCodexAccount(bound("work"), {}, { openClient: () => Promise.reject(deadline) }).catch(
            (err: unknown) => err
        );

        expect((caught as { cause?: unknown }).cause).toBe(deadline);
        expect(isTransportFailure(caught)).toBe(true);
    });

    it("reports a home with no login instead of throwing", async () => {
        const client = fakeClient({});

        const snapshot = await pollCodexAccount(bound("side"), {}, { openClient: async () => client });

        expect(snapshot.limits).toEqual([]);
        expect(snapshot.error).toContain("no rate limits");
        expect(snapshot.auth?.reason).toBe("not logged in");
        expect(client.closed).toBe(1);
    });
});

describe("vault account usage", () => {
    it("polls a selected vault account without requiring or falling back to a native home", async () => {
        const account = entry("vault", { accessToken: "selected-access", refreshToken: "selected-refresh" });
        const client = fakeClient(CAMEL);
        const selected: AccountEntry[] = [];
        const snapshot = await pollCodexAccount(
            account,
            { probe: true },
            {
                openClient: async (boundAccount, options) => {
                    selected.push(boundAccount);
                    expect(options.probe).toBe(true);
                    return client;
                },
            }
        );
        expect(selected).toEqual([account]);
        expect(snapshot.accountId).toBe(account.id);
        expect(snapshot.limits).toHaveLength(2);
        expect(client.closed).toBe(1);
    });
});

it("vault credential stamps are independent of an old native data directory", async () => {
    const { codexCredentialStamp } = await import("./usage");
    const account = entry("vault", { accessToken: "vault-access", expiresAt: 12345, dataDir: "/obsolete-profile" });
    expect(codexHomeFor(account)).toBeNull();
    expect(await codexCredentialStamp(account)).toBe(12345);
});
