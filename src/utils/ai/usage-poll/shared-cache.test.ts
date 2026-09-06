import { afterEach, describe, expect, test } from "bun:test";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { snapshotToAccountUsage } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage";
import type { CodexUsageClient } from "@genesiscz/utils/ai/providers/plugins/openai-sub/usage";
import { codexUsage, pollCodexAccount } from "@genesiscz/utils/ai/providers/plugins/openai-sub/usage";
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
): (opts: { force?: boolean; accountFilter?: string | string[]; floorMs?: number }) => Promise<AccountUsageSnapshot[]> {
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

    // `force` means "do not serve me the shared 45s window", not "fetch unconditionally".
    // The every-30s daemon polls with force, and used to spawn a `codex app-server` and hit
    // grok on every tick despite their 120s and 300s floors (PR #361 review t3).
    test("a provider floor survives force", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 30_000,
            accounts: [snapshot("openai-sub", "work", 11)],
        });
        let polls = 0;

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => {
                polls++;
                return [snapshot("openai-sub", "work", 3)];
            })
        );

        const served = await get({ force: true, floorMs: 120_000 });

        expect(polls).toBe(0);
        expect(served[0].limits[0].percentUsed).toBe(11);
    });

    // Negative control: past the floor, force still fetches. Without this a floor that
    // leaked into the normal path would freeze every provider silently.
    test("force fetches once the floor has elapsed", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 130_000,
            accounts: [snapshot("openai-sub", "work", 11)],
        });
        let polls = 0;

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => {
                polls++;
                return [snapshot("openai-sub", "work", 3)];
            })
        );

        const fetched = await get({ force: true, floorMs: 120_000 });

        expect(polls).toBe(1);
        expect(fetched[0].limits[0].percentUsed).toBe(3);
    });

    // A filtered round used to stamp the WHOLE provider fresh. On a cold cache, polling
    // `work` and then `personal` inside the window answered `personal` with nothing at all
    // (PR #361 review t6).
    test("a filtered poll does not mark the accounts it skipped fresh", async () => {
        const store: CacheStore = new Map();
        const fetched: string[][] = [];

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => {
                const round = fetched.length;
                fetched.push(round === 0 ? ["work"] : ["personal"]);
                return round === 0 ? [snapshot("openai-sub", "work", 11)] : [snapshot("openai-sub", "personal", 22)];
            })
        );

        await get({ accountFilter: "work" });
        const second = await get({ accountFilter: "personal" });

        expect(fetched).toEqual([["work"], ["personal"]]);
        expect(second.map((a) => a.accountName)).toEqual(["personal"]);
    });

    // The same trap with a warm cache: repeated `work`-only polls must not keep an old
    // `personal` reading alive forever behind one provider-wide stamp.
    test("a carried-over account keeps its own age", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:openai-sub", {
            fetchedAt: Date.now() - 300_000,
            accounts: [snapshot("openai-sub", "work", 11), snapshot("openai-sub", "personal", 22)],
        });
        const rounds: Array<string | string[] | undefined> = [];

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => {
                rounds.push("work");
                return [snapshot("openai-sub", "work", 44)];
            })
        );

        await get({ accountFilter: "work" });
        const personal = await get({ accountFilter: "personal" });

        // The `work` round refreshed only `work`, so reading `personal` fetches again.
        expect(rounds).toHaveLength(2);
        expect(personal.map((a) => a.accountName)).toEqual([]);
    });

    // Negative control: the account a filtered round DID fetch is served from cache, so
    // the coverage check cannot have turned every read into a fetch.
    test("re-reading the account a filtered round fetched is served from cache", async () => {
        const store: CacheStore = new Map();
        let polls = 0;

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => {
                polls++;
                return [snapshot("openai-sub", "work", 11)];
            })
        );

        await get({ accountFilter: "work" });
        const again = await get({ accountFilter: "work" });

        expect(polls).toBe(1);
        expect(again[0].limits[0].percentUsed).toBe(11);
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

    // `snapshotToAccountUsage` derives the whole `AccountUsage` row from `native` alone, so
    // a backfill that copied only `limits` left the claude presenter, `tools claude start`
    // and the Genesis projection with no usage bars after one transient failure
    // (PR #361 review t4). Asserted through that conversion, not on `limits`.
    test("a backfill carries the native payload the claude readers project from", async () => {
        const native = {
            five_hour: { utilization: 33, resets_at: null },
            seven_day: { utilization: 12, resets_at: null },
        };
        const store: CacheStore = new Map();
        store.set("snapshots:anthropic-sub", {
            fetchedAt: Date.now() - 120_000,
            accounts: [{ ...snapshot("anthropic-sub", "work", 33), native }],
        });

        const get = makeGet(
            "anthropic-sub",
            storeDeps(store, async () => [errored("anthropic-sub", "work", "usage read timed out")])
        );

        const [backfilled] = await get({ force: true });

        expect(backfilled.native).toEqual(native);
        expect(snapshotToAccountUsage(backfilled).usage).toEqual(native);
    });

    // Negative control: a live row keeps its OWN native payload, so the copy above can
    // never overwrite fresh data with the previous round's.
    test("a fetched row keeps its own native payload", async () => {
        const store: CacheStore = new Map();
        store.set("snapshots:anthropic-sub", {
            fetchedAt: Date.now() - 120_000,
            accounts: [
                {
                    ...snapshot("anthropic-sub", "work", 33),
                    native: {
                        five_hour: { utilization: 33, resets_at: null },
                        seven_day: { utilization: 12, resets_at: null },
                    },
                },
            ],
        });

        const fresh = { five_hour: { utilization: 71, resets_at: null } };
        const get = makeGet(
            "anthropic-sub",
            storeDeps(store, async () => [{ ...snapshot("anthropic-sub", "work", 71), native: fresh }])
        );

        const [row] = await get({ force: true });

        expect(row.native).toEqual(fresh);
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
/**
 * The daemon's own cadence, driven the way launchd drives it: one FORCED round every 30s,
 * forever. `force` means "do not serve me the shared 45s window", never "ignore the
 * provider's own floor" — a codex round spawns a `codex app-server` per account, so a floor
 * that force could bypass meant one process per account per tick (PR #359 review t1, the
 * same subject as PR #361 t3).
 *
 * The spy is the thing that actually spawns: `openClient`, injected into the real
 * `codexUsage.poll`, not a stand-in fetcher.
 */
describe("forced daemon rounds against the codex poll", () => {
    const realNow = Date.now;

    afterEach(() => {
        Date.now = realNow;
    });

    // The plugin's OWN floor and the daemon's own period, not invented numbers.
    const CODEX_FLOOR_MS = codexUsage.minIntervalMs ?? 0;
    const TICK_MS = 30_000;

    function codexAccount(name: string): AccountEntry {
        return {
            id: `acc_${name}`,
            name,
            provider: "openai-sub",
            credentials: { dataDir: `/tmp/.codex-${name}` },
        } as AccountEntry;
    }

    /** An app-server that answers one rate-limit read and closes. */
    function fakeAppServer(): CodexUsageClient {
        return {
            async request<T>(): Promise<T> {
                return { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300 } } } as T;
            },
            async notify() {},
            async close() {},
        };
    }

    /** `ticks` forced rounds `TICK_MS` apart, returning how often an app-server was opened. */
    async function runTicks(ticks: number, floorMs: number): Promise<number> {
        const store: CacheStore = new Map();
        const account = codexAccount("work");
        let spawned = 0;
        let clock = 1_800_000_000_000;
        Date.now = () => clock;

        const get = makeGet(
            "openai-sub",
            storeDeps(store, async () => [
                await pollCodexAccount(
                    account,
                    {},
                    {
                        openClient: async () => {
                            spawned += 1;
                            return fakeAppServer();
                        },
                    }
                ),
            ])
        );

        for (let tick = 0; tick < ticks; tick++) {
            await get({ force: true, floorMs });
            clock += TICK_MS;
        }

        return spawned;
    }

    // The spy sits on the function the plugin actually registers, so this drives the
    // production path rather than a stand-in.
    test("the plugin's registered poll is the one under test", () => {
        expect(codexUsage.poll).toBe(pollCodexAccount);
        expect(CODEX_FLOOR_MS).toBe(120_000);
    });

    // Ten ticks span 270s. At the 120s floor that is one round at 0s, 120s and 240s.
    test("ten forced rounds spawn three app-servers, not ten", async () => {
        expect(await runTicks(10, CODEX_FLOOR_MS)).toBe(3);
    });

    // Negative control: with the floor at one tick, every forced round still polls. A floor
    // that leaked into the normal path would freeze the daemon instead of pacing it.
    test("a floor of one tick still polls on every forced round", async () => {
        expect(await runTicks(10, TICK_MS)).toBe(10);
    });
});
