import { describe, expect, test } from "bun:test";
import type { AccountUsage } from "./api";
import { __makeSharedUsage } from "./shared-cache";

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
        const store = new Map<string, unknown>();
        store.set("usage-shared", { fetchedAt: Date.now() - 5_000, accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => {
                fetches++;
                return [acct("a", 99)];
            },
            getCache: (k) => (store.get(k) as never) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
            record: () => {},
        });
        const r = await get({});
        expect(fetches).toBe(0);
        expect(r[0].usage?.five_hour.utilization).toBe(11);
    });

    test("fetches + records + writes cache when stale", async () => {
        let fetches = 0;
        let recorded = 0;
        const store = new Map<string, unknown>();
        store.set("usage-shared", { fetchedAt: Date.now() - 60_000, accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => {
                fetches++;
                return [acct("a", 42)];
            },
            getCache: (k) => (store.get(k) as never) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
            record: () => {
                recorded++;
            },
        });
        const r = await get({});
        expect(fetches).toBe(1);
        expect(recorded).toBe(1);
        expect(r[0].usage?.five_hour.utilization).toBe(42);
        expect(
            (store.get("usage-shared") as { accounts: AccountUsage[] }).accounts[0].usage?.five_hour.utilization
        ).toBe(42);
    });

    test("force bypasses a fresh cache", async () => {
        let fetches = 0;
        const store = new Map<string, unknown>();
        store.set("usage-shared", { fetchedAt: Date.now(), accounts: [acct("a", 11)] });
        const get = __makeSharedUsage({
            fetchAll: async () => {
                fetches++;
                return [acct("a", 7)];
            },
            getCache: (k) => (store.get(k) as never) ?? null,
            putCache: (k, v) => void store.set(k, v),
            withLock: async (_k, fn) => fn(),
            record: () => {},
        });
        await get({ force: true });
        expect(fetches).toBe(1);
    });

    test("accountFilter narrows the returned set", async () => {
        const store = new Map<string, unknown>();
        store.set("usage-shared", { fetchedAt: Date.now(), accounts: [acct("a", 1), acct("b", 2)] });
        const get = __makeSharedUsage({
            fetchAll: async () => [],
            getCache: (k) => (store.get(k) as never) ?? null,
            putCache: () => {},
            withLock: async (_k, fn) => fn(),
            record: () => {},
        });
        const r = await get({ accountFilter: "b" });
        expect(r.map((x) => x.accountName)).toEqual(["b"]);
    });
});
