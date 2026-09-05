import { describe, expect, test } from "bun:test";
import type { Cached, SharedUsageDeps } from "./shared-cache";
import { __makeSharedUsage, SNAPSHOT_OPS } from "./shared-cache";
import type { AccountUsageSnapshot } from "./types";

/**
 * The provider-neutral half of the shared cache. The anthropic wiring (which supplies
 * `ACCOUNT_USAGE_OPS`) is pinned by `src/claude/lib/usage/shared-cache.test.ts`; `src/utils`
 * is a self-contained package and cannot import from `src/claude`.
 */

type CacheStore = Map<string, Cached<AccountUsageSnapshot>>;

function snapshot(provider: string, name: string, percent: number): AccountUsageSnapshot {
    return {
        provider,
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [{ key: "primary", label: "5h", kind: "session", percentUsed: percent }],
    };
}

function errored(provider: string, name: string, error: string): AccountUsageSnapshot {
    return {
        provider,
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [],
        error,
    };
}

function makeGet(
    provider: string,
    deps: Omit<SharedUsageDeps<AccountUsageSnapshot>, "provider" | "ops">
): (opts: { force?: boolean; accountFilter?: string | string[] }) => Promise<AccountUsageSnapshot[]> {
    return __makeSharedUsage<AccountUsageSnapshot>({ provider, ops: SNAPSHOT_OPS, ...deps });
}

function storeDeps(store: CacheStore, fetchAll: () => Promise<AccountUsageSnapshot[]>, lockKeys?: string[]) {
    return {
        fetchAll,
        getCache: (k: string) => store.get(k) ?? null,
        putCache: (k: string, v: Cached<AccountUsageSnapshot>) => void store.set(k, v),
        withLock: async <R>(k: string, fn: () => Promise<R>): Promise<R> => {
            lockKeys?.push(k);
            return fn();
        },
    };
}

describe("pollAccounts cache, per provider", () => {
    // The cache file holds the whole provider. A filtered poll fetches one account, so
    // writing the fetched list alone erased everyone else until the next full round.
    test("a filtered poll keeps the accounts it never fetched in the cache", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 300_000,
            accounts: [snapshot("openai-sub", "work", 11), snapshot("openai-sub", "personal", 22)],
        });

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => [snapshot("openai-sub", "work", 44)])
        );

        const returned = await get({ force: true, accountFilter: "work" });

        expect(returned.map((a) => a.accountName)).toEqual(["work"]);
        const cached = store.get("snapshots:openai-sub");
        expect(cached?.accounts.map((a) => a.accountName).sort()).toEqual(["personal", "work"]);
        expect(cached?.accounts.find((a) => a.accountName === "work")?.limits[0].percentUsed).toBe(44);
        expect(cached?.accounts.find((a) => a.accountName === "personal")?.limits[0].percentUsed).toBe(22);
    });

    // Negative control: an unfiltered poll still replaces the whole set, so an account
    // that was removed from the config does not linger in the cache forever.
    test("an unfiltered poll replaces the whole account set", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 300_000,
            accounts: [snapshot("openai-sub", "work", 11), snapshot("openai-sub", "gone", 22)],
        });

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => [snapshot("openai-sub", "work", 44)])
        );

        await get({ force: true });

        expect(store.get("snapshots:openai-sub")?.accounts.map((a) => a.accountName)).toEqual(["work"]);
    });

    test("serves cache inside the freshness window without polling", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 5_000,
            accounts: [snapshot("openai-sub", "work", 11)],
        });
        let polls = 0;

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => {
                polls++;
                return [snapshot("openai-sub", "work", 99)];
            })
        );

        const result = await get({});

        expect(polls).toBe(0);
        expect(result[0].limits[0].percentUsed).toBe(11);
    });

    test("two providers never share a cache entry or a lock key", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:anthropic-sub", {
            fetchedAt: Date.now(),
            accounts: [snapshot("anthropic-sub", "work", 11)],
        });
        const lockKeys: string[] = [];

        const grok = makeGet(
            "grok-sub",
            storeDeps(store, async () => [snapshot("grok-sub", "work", 77)], lockKeys)
        );

        const result = await grok({});

        expect(lockKeys).toEqual(["snapshots:grok-sub"]);
        expect(result[0].limits[0].percentUsed).toBe(77);
        expect(store.get("snapshots:anthropic-sub")?.accounts[0].limits[0].percentUsed).toBe(11);
    });

    test("force bypasses a fresh entry", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:grok-sub", { fetchedAt: Date.now(), accounts: [snapshot("grok-sub", "work", 11)] });
        let polls = 0;

        const get = makeGet(
            "grok-sub",
            storeDeps(store, async () => {
                polls++;
                return [snapshot("grok-sub", "work", 3)];
            })
        );

        await get({ force: true });

        expect(polls).toBe(1);
    });

    test("accountFilter narrows the returned set", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now(),
            accounts: [snapshot("openai-sub", "work", 1), snapshot("openai-sub", "personal", 2)],
        });

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => [])
        );

        const result = await get({ accountFilter: "personal" });

        expect(result.map((r) => r.accountName)).toEqual(["personal"]);
    });
});

describe("SNAPSHOT_OPS", () => {
    test("a failed account is backfilled from last good and marked stale", async () => {
        const lastGoodAt = Date.now() - 120_000;
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: lastGoodAt,
            accounts: [snapshot("openai-sub", "work", 33), snapshot("openai-sub", "personal", 44)],
        });

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => [
                errored("openai-sub", "work", "app-server timed out"),
                snapshot("openai-sub", "personal", 55),
            ])
        );

        const result = await get({ force: true });
        const work = result.find((r) => r.accountName === "work");
        const personal = result.find((r) => r.accountName === "personal");

        expect(work?.limits[0].percentUsed).toBe(33);
        expect(work?.error).toContain("timed out");
        expect(work?.stale?.lastSuccessAt).toBe(new Date(lastGoodAt).toISOString());
        expect(work?.stale?.reason).toContain("timed out");
        expect(personal?.stale).toBeUndefined();
    });

    test("chained failures keep the ORIGINAL lastSuccessAt", async () => {
        const originalAt = "2026-09-04T12:00:00.000Z";
        const store: CacheStore = new Map();
        store.set("snapshots:grok-sub", {
            fetchedAt: Date.now() - 60_000,
            accounts: [
                {
                    ...snapshot("grok-sub", "work", 33),
                    error: "round 1",
                    stale: { lastSuccessAt: originalAt, reason: "round 1" },
                },
            ],
        });

        const get = makeGet(
            "grok-sub",
            storeDeps(store, async () => [errored("grok-sub", "work", "round 2")])
        );

        const result = await get({ force: true });

        expect(result[0].limits[0].percentUsed).toBe(33);
        expect(result[0].stale?.lastSuccessAt).toBe(originalAt);
        expect(result[0].stale?.reason).toContain("round 2");
    });

    test("orgBlocked is sticky across a backfill", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:anthropic-sub", {
            fetchedAt: Date.now() - 60_000,
            accounts: [{ ...snapshot("anthropic-sub", "shop", 10), auth: { orgBlocked: true } }],
        });

        let seen: ReadonlySet<string> | undefined;
        const get = __makeSharedUsage<AccountUsageSnapshot>({
            provider: "anthropic-sub",
            ops: SNAPSHOT_OPS,
            fetchAll: async (opts) => {
                seen = opts.orgBlocked;
                return [errored("anthropic-sub", "shop", "429 rate limited")];
            },
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });

        const result = await get({});

        expect(seen?.has("shop")).toBe(true);
        expect(result[0].auth?.orgBlocked).toBe(true);
        expect(result[0].limits).toHaveLength(1);
    });

    test("a lock failure degrades to the cached payload, marked stale", async () => {
        const cachedAt = Date.now() - 90_000;
        const store: CacheStore = new Map();
        store.set("snapshots:grok-sub", { fetchedAt: cachedAt, accounts: [snapshot("grok-sub", "work", 33)] });

        const get = makeGet("grok-sub", {
            fetchAll: async () => [snapshot("grok-sub", "work", 99)],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async () => {
                throw new Error("Failed to acquire file lock at /x within 10000ms.");
            },
        });

        const result = await get({ force: true });

        expect(result[0].limits[0].percentUsed).toBe(33);
        expect(result[0].stale?.lastSuccessAt).toBe(new Date(cachedAt).toISOString());
        expect(result[0].stale?.reason).toContain("Failed to acquire file lock");
    });

    test("a lock failure with NO cache rethrows", async () => {
        const get = makeGet("grok-sub", {
            fetchAll: async () => [],
            getCache: () => null,
            putCache: () => {},
            withLock: async () => {
                throw new Error("Failed to acquire file lock at /x within 10000ms.");
            },
        });

        await expect(get({})).rejects.toThrow("Failed to acquire file lock");
    });

    /**
     * `onFresh` writes the legacy `usage-shared` file the Genesis app decodes. Handing it
     * this round's rows only would shrink that file to whatever one filtered poll fetched,
     * so it gets the same set the cache got.
     */
    test("onFresh gets the accounts a filtered round never fetched", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 300_000,
            accounts: [snapshot("openai-sub", "work", 11), snapshot("openai-sub", "personal", 22)],
        });

        const projected: string[][] = [];
        const recorded: string[][] = [];
        const get = makeGet("openai-sub", {
            ...storeDeps(store, async () => [snapshot("openai-sub", "work", 44)]),
            recordHistory: (snapshots) => {
                recorded.push(snapshots.map((s) => s.accountName));
            },
            onFresh: (snapshots) => {
                projected.push(snapshots.map((s) => s.accountName));
            },
        });

        await get({ force: true, accountFilter: "work" });

        expect(projected).toEqual([["work", "personal"]]);
        // The write-through still sees only what was actually fetched: recording a carried
        // row would re-timestamp an old reading as current.
        expect(recorded).toEqual([["work"]]);
    });

    test("history write-through and onFresh fire only on a live fetch", async () => {
        const store: CacheStore = new Map();
        const recorded: number[] = [];
        const projected: number[] = [];
        const get = makeGet("openai-sub", {
            ...storeDeps(store, async () => [snapshot("openai-sub", "work", 42)]),
            recordHistory: (snapshots) => {
                recorded.push(snapshots.length);
            },
            onFresh: (snapshots) => {
                projected.push(snapshots.length);
            },
        });

        await get({});
        expect(recorded).toEqual([1]);
        expect(projected).toEqual([1]);

        await get({});
        expect(recorded).toEqual([1]);
        expect(projected).toEqual([1]);
    });

    test("a write-through failure does not fail the poll", async () => {
        const store: CacheStore = new Map();
        const get = makeGet("openai-sub", {
            ...storeDeps(store, async () => [snapshot("openai-sub", "work", 42)]),
            recordHistory: () => {
                throw new Error("db locked");
            },
        });

        const result = await get({});

        expect(result[0].limits[0].percentUsed).toBe(42);
    });
});
