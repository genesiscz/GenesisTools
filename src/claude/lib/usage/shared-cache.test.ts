import { describe, expect, test } from "bun:test";
import type { AccountUsage } from "./api";
import { __makeSharedUsage } from "./shared-cache";

interface CachedEntry {
    fetchedAt: number;
    accounts: AccountUsage[];
}

type CacheStore = Map<string, CachedEntry>;

function acct(name: string, util: number): AccountUsage {
    return {
        accountName: name,
        label: name,
        usage: {
            five_hour: { utilization: util, resets_at: null },
            seven_day: { utilization: 0, resets_at: null },
        },
    } as AccountUsage;
}

describe("getSharedAccountsUsage", () => {
    test("serves cache when fetch happened < maxStaleMs ago (no Anthropic call)", async () => {
        let fetches = 0;
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: Date.now() - 5_000, accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => {
                fetches++;
                return [acct("a", 99)];
            },
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });
        const r = await get({});
        expect(fetches).toBe(0);
        expect(r[0].usage?.five_hour.utilization).toBe(11);
    });

    test("fetches + writes cache when stale (recording is daemon-owned)", async () => {
        let fetches = 0;
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: Date.now() - 60_000, accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => {
                fetches++;
                return [acct("a", 42)];
            },
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });
        const r = await get({});
        expect(fetches).toBe(1);
        expect(r[0].usage?.five_hour.utilization).toBe(42);
        expect((store.get("usage-shared") as CachedEntry).accounts[0].usage?.five_hour.utilization).toBe(42);
    });

    test("force bypasses a fresh cache", async () => {
        let fetches = 0;
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: Date.now(), accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => {
                fetches++;
                return [acct("a", 7)];
            },
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });
        await get({ force: true });
        expect(fetches).toBe(1);
    });

    test("invokes extra-usage notify only on a live fetch", async () => {
        let notifyCalls = 0;
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: Date.now() - 5_000, accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => [acct("a", 42)],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
            notifyExtraUsage: async () => {
                notifyCalls++;
            },
        });

        await get({});
        expect(notifyCalls).toBe(0);

        store.set("usage-shared", { fetchedAt: Date.now() - 60_000, accounts: [acct("a", 11)] });
        await get({});
        expect(notifyCalls).toBe(1);
    });

    test("accountFilter narrows the returned set", async () => {
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: Date.now(), accounts: [acct("a", 1), acct("b", 2)] });
        const get = __makeSharedUsage({
            fetchAll: async () => [],
            getCache: (k) => store.get(k) ?? null,
            putCache: () => {},
            withLock: async (_k, fn) => fn(),
        });
        const r = await get({ accountFilter: "b" });
        expect(r.map((x) => x.accountName)).toEqual(["b"]);
    });

    test("backfills a per-account fetch error with last-good usage, marked stale", async () => {
        const lastGoodAt = Date.now() - 120_000;
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: lastGoodAt, accounts: [acct("a", 33), acct("b", 44)] });
        const get = __makeSharedUsage({
            fetchAll: async () => [
                { accountName: "a", label: "a", error: "TimeoutError: The operation timed out." },
                acct("b", 55),
            ],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });

        const r = await get({ force: true });
        const a = r.find((x) => x.accountName === "a");
        const b = r.find((x) => x.accountName === "b");

        expect(a?.usage?.five_hour.utilization).toBe(33);
        expect(a?.error).toContain("TimeoutError");
        expect(a?.stale?.lastSuccessAt).toBe(lastGoodAt);
        expect(a?.stale?.reason).toContain("TimeoutError");
        expect(b?.usage?.five_hour.utilization).toBe(55);
        expect(b?.stale).toBeUndefined();
    });

    test("chained failures preserve the ORIGINAL lastSuccessAt, not the latest cache write", async () => {
        const originalAt = Date.now() - 600_000;
        const store: CacheStore = new Map();
        store.set("usage-shared", {
            fetchedAt: Date.now() - 60_000,
            accounts: [
                {
                    ...acct("a", 33),
                    error: "TimeoutError (round 1)",
                    stale: { lastSuccessAt: originalAt, reason: "TimeoutError (round 1)" },
                },
            ],
        });
        const get = __makeSharedUsage({
            fetchAll: async () => [{ accountName: "a", label: "a", error: "TimeoutError (round 2)" }],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });

        const r = await get({ force: true });

        expect(r[0].usage?.five_hour.utilization).toBe(33);
        expect(r[0].stale?.lastSuccessAt).toBe(originalAt);
        expect(r[0].stale?.reason).toContain("round 2");
    });

    test("lock failure degrades to the cached payload, all usage-bearing accounts marked stale", async () => {
        const cachedAt = Date.now() - 90_000;
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: cachedAt, accounts: [acct("a", 33)] });
        const get = __makeSharedUsage({
            fetchAll: async () => [acct("a", 99)],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async () => {
                throw new Error("Failed to acquire file lock at /x within 10000ms.");
            },
        });

        const r = await get({ force: true });

        expect(r[0].usage?.five_hour.utilization).toBe(33);
        expect(r[0].stale?.lastSuccessAt).toBe(cachedAt);
        expect(r[0].stale?.reason).toContain("Failed to acquire file lock");
    });

    test("lock failure with NO cache rethrows", async () => {
        const get = __makeSharedUsage({
            fetchAll: async () => [],
            getCache: () => null,
            putCache: () => {},
            withLock: async () => {
                throw new Error("Failed to acquire file lock at /x within 10000ms.");
            },
        });

        await expect(get({})).rejects.toThrow("Failed to acquire file lock");
    });

    test("stale entries are excluded from the extra-usage notify pass", async () => {
        const notified: string[][] = [];
        const store: CacheStore = new Map();
        store.set("usage-shared", { fetchedAt: Date.now() - 60_000, accounts: [acct("a", 33), acct("b", 44)] });
        const get = __makeSharedUsage({
            fetchAll: async () => [{ accountName: "a", label: "a", error: "boom" }, acct("b", 55)],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
            notifyExtraUsage: (accounts) => {
                notified.push(accounts.map((x) => x.accountName));
            },
        });

        await get({ force: true });

        expect(notified).toEqual([["b"]]);
    });

    test("a later successful fetch clears the stale marker", async () => {
        const store: CacheStore = new Map();
        store.set("usage-shared", {
            fetchedAt: Date.now() - 60_000,
            accounts: [
                {
                    ...acct("a", 33),
                    error: "TimeoutError",
                    stale: { lastSuccessAt: Date.now() - 600_000, reason: "TimeoutError" },
                },
            ],
        });
        const get = __makeSharedUsage({
            fetchAll: async () => [acct("a", 77)],
            getCache: (k) => store.get(k) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
        });

        const r = await get({ force: true });

        expect(r[0].usage?.five_hour.utilization).toBe(77);
        expect(r[0].stale).toBeUndefined();
        expect(r[0].error).toBeUndefined();
    });
});
