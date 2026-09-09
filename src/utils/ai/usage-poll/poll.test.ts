import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures, AccountUsageFeature } from "@genesiscz/utils/ai/providers/account-features";
import { _resetBuiltInPluginsForTest } from "@genesiscz/utils/ai/providers/plugins";
import { _resetPluginsForTest } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { formatBlockedNotice, formatNeedsLoginNotice } from "./format-blocked";
import { mergeAccountSlice } from "./legacy-cache";
import { __fetchProviderSnapshots, latestFetchedAt, type UsagePlugin, usagePlugins } from "./poll";
import { blockedEntry, loadPollGate, type PollGate, recordFailure, savePollGate } from "./poll-gate";
import { __resetUsagePollStorage } from "./storage";
import type { AccountUsageSnapshot } from "./types";

/**
 * The registry is per-process and starts EMPTY. Every other consumer in the repo calls
 * `registerBuiltInPlugins()` at its own entry point, which is exactly why the poll core
 * failed silently: the launchd `ai-usage-poll` daemon imports nothing else, so it read an
 * empty registry, polled nobody, and reported success. `tools ai usage` masked it, because
 * registering the `config` commands registers the plugins as a side effect.
 *
 * Both resets are needed to reach that state, and they must stay paired: the registry map
 * lives in `registry.ts` while the "already registered" latch lives in `plugins.ts`, so
 * clearing only the map leaves `registerBuiltInPlugins()` believing its work is done.
 * A test with fake plugins cannot see this bug at all.
 */

function freshProcess(): void {
    _resetPluginsForTest();
    _resetBuiltInPluginsForTest();
}

afterEach(() => {
    freshProcess();
    // Leave the registry populated for whatever runs next in this process.
    usagePlugins();
});

describe("usagePlugins", () => {
    test("registers the built-in plugins itself, so a fresh process is not empty", () => {
        freshProcess();

        expect(
            usagePlugins()
                .map((entry) => entry.plugin.id)
                .sort()
        ).toEqual(["anthropic-sub", "grok-sub", "openai-sub"]);
    });

    test("every entry carries the narrowed usage feature and its poll floor", () => {
        freshProcess();

        for (const entry of usagePlugins()) {
            expect(typeof entry.usage.poll).toBe("function");
            expect(entry.usage.minIntervalMs).toBeGreaterThan(0);
            expect(entry.features.presentation.prominentLimits.length).toBeGreaterThan(0);
        }
    });

    // Idempotence is what lets the call sit at the read site rather than at one entry
    // point: a second read must not duplicate a provider.
    test("a second call does not register a provider twice", () => {
        freshProcess();

        const first = usagePlugins().map((entry) => entry.plugin.id);
        const second = usagePlugins().map((entry) => entry.plugin.id);

        expect(second).toEqual(first);
        expect(new Set(second).size).toBe(second.length);
    });
});

describe("mergeAccountSlice", () => {
    function snapshot(name: string, percent: number): AccountUsageSnapshot {
        return {
            provider: "openai-sub",
            accountId: `acc_${name}`,
            accountName: name,
            fetchedAt: "2026-09-04T18:00:00.000Z",
            limits: [{ key: "primary", label: "Session", kind: "session", percentUsed: percent }],
        };
    }

    // The all-provider file is what the dashboard and the Genesis app read. A one-account
    // poll used to replace the provider's whole slice with that one account.
    test("carries over the accounts this round never polled", () => {
        const merged = mergeAccountSlice([snapshot("work", 11), snapshot("personal", 22)], [snapshot("work", 44)]);

        expect(merged.map((s) => s.accountName)).toEqual(["work", "personal"]);
        expect(merged[0].limits[0].percentUsed).toBe(44);
        expect(merged[1].limits[0].percentUsed).toBe(22);
    });

    // Negative control: with no previous slice (the unfiltered path passes undefined) the
    // fresh set stands alone, so a removed account does not linger.
    test("an absent previous slice leaves the fresh set untouched", () => {
        const fresh = [snapshot("work", 44)];

        expect(mergeAccountSlice(undefined, fresh)).toBe(fresh);
        expect(mergeAccountSlice([], fresh)).toBe(fresh);
    });
});

/**
 * `pollAccounts` runs on every read and most reads are served from the 45s cache, so the
 * file-level stamp used to say "fetched now" about rows that were minutes old.
 */
describe("latestFetchedAt", () => {
    function at(name: string, fetchedAt: string): AccountUsageSnapshot {
        return {
            provider: "anthropic-sub",
            accountId: `acc_${name}`,
            accountName: name,
            fetchedAt,
            limits: [],
        };
    }

    const now = new Date("2026-09-05T18:00:00.000Z");

    test("reports the newest row's own fetch time, not the wall clock", () => {
        const stamp = latestFetchedAt(
            [at("work", "2026-09-05T17:58:00.000Z"), at("personal", "2026-09-05T17:59:30.000Z")],
            now
        );

        expect(stamp.toISOString()).toBe("2026-09-05T17:59:30.000Z");
    });

    test("falls back to now when a round returned nothing datable", () => {
        expect(latestFetchedAt([], now)).toBe(now);
        expect(latestFetchedAt([at("work", "not a date")], now)).toBe(now);
    });
});

/**
 * The round itself, driven with a fake plugin against a temporary home. Everything that
 * decides whether an account is polled, suppressed or blocked lives in
 * `__fetchProviderSnapshots`, so a rule that is not exercised here is not covered at all.
 */
describe("__fetchProviderSnapshots", () => {
    const PROVIDER = "fake-sub";
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }

        env.testing.unset("GENESIS_TOOLS_HOME");
        __resetUsagePollStorage();
    });

    function useTempHome(): void {
        const home = mkdtempSync(join(tmpdir(), "ai-usage-round-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        __resetUsagePollStorage();
        cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    }

    function account(name: string, credentials: AccountEntry["credentials"] = {}): AccountEntry {
        return {
            id: `acc_${name}`,
            name,
            provider: PROVIDER,
            enabled: true,
            billing: { mode: "subscription" },
            credentials,
            useEnvApiKey: false,
        };
    }

    function ok(entry: AccountEntry): AccountUsageSnapshot {
        return {
            provider: PROVIDER,
            accountId: entry.id,
            accountName: entry.name,
            fetchedAt: new Date().toISOString(),
            limits: [{ key: "weekly", label: "Weekly", kind: "weekly", percentUsed: 12 }],
        };
    }

    function fakePlugin(args: {
        poll: AccountUsageFeature["poll"];
        credentialStamp?: AccountUsageFeature["credentialStamp"];
    }): UsagePlugin {
        const usage: AccountUsageFeature = {
            poll: args.poll,
            ...(args.credentialStamp === undefined ? {} : { credentialStamp: args.credentialStamp }),
        };
        const features: AccountFeatures = {
            presentation: { displayName: "Fake", alias: "fake", limitOrder: [], prominentLimits: [] },
            logoutTargets: [],
            usage,
        };

        return {
            plugin: {
                id: PROVIDER,
                kind: "subscription",
                capabilities: new Set(),
                credential: { fields: ["authFile"], envKeys: [] },
                bind: () => Promise.reject(new Error("the fake plugin is never bound")),
                accounts: features,
            },
            features,
            usage,
        };
    }

    // Codex answers a logged-out home with an error ROW rather than an exception, and the
    // round used to count any fulfilled promise as a success — which cleared the very
    // backoff that row should have earned.
    test("a snapshot that came back carrying an error earns a failure", async () => {
        useTempHome();
        const work = account("work");
        const entry = fakePlugin({
            poll: (target) =>
                Promise.resolve({ ...ok(target), limits: [], error: "codex app-server reported no rate limits" }),
        });

        await __fetchProviderSnapshots(entry, [work], {}, new Set());

        expect((await loadPollGate(PROVIDER)).work.failures).toBe(1);
    });

    test("an error row never clears a backoff the account already earned", async () => {
        useTempHome();
        const work = account("work");
        const now = Date.now();
        // One failure only: two would block the account and it would never be polled.
        await savePollGate(PROVIDER, recordFailure({}, "work", "earlier failure", now));

        const entry = fakePlugin({
            poll: (target) => Promise.resolve({ ...ok(target), limits: [], error: "still broken" }),
        });

        await __fetchProviderSnapshots(entry, [work], {}, new Set());

        expect((await loadPollGate(PROVIDER)).work.failures).toBe(2);
    });

    // Negative control: a clean round still clears the gate, or the fix above would have
    // turned every account permanently blocked.
    test("a clean snapshot still clears the backoff", async () => {
        useTempHome();
        const work = account("work");
        await savePollGate(PROVIDER, recordFailure({}, "work", "earlier failure", Date.now()));

        const entry = fakePlugin({ poll: (target) => Promise.resolve(ok(target)) });
        const snapshots = await __fetchProviderSnapshots(entry, [work], {}, new Set());

        expect(snapshots[0].error).toBeUndefined();
        expect((await loadPollGate(PROVIDER)).work).toBeUndefined();
    });

    test("a thrown failure is still recorded as one", async () => {
        useTempHome();
        const work = account("work");
        const entry = fakePlugin({ poll: () => Promise.reject(new Error("Usage API 401: unauthorized")) });

        const snapshots = await __fetchProviderSnapshots(entry, [work], {}, new Set());

        expect(snapshots[0].error).toContain("401");
        const gate: PollGate = await loadPollGate(PROVIDER);
        expect(gate.work.failures).toBe(1);
    });
});

/**
 * The recovery half of the gate, at the level the daemon actually runs it. A grok or codex
 * account is repaired by the VENDOR CLI, so the only thing that can release its block is
 * the auth file's stamp moving past the failure.
 */
describe("__fetchProviderSnapshots and a repaired credential", () => {
    const PROVIDER = "fake-sub";
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }

        env.testing.unset("GENESIS_TOOLS_HOME");
        __resetUsagePollStorage();
    });

    function useTempHome(): void {
        const home = mkdtempSync(join(tmpdir(), "ai-usage-release-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        __resetUsagePollStorage();
        cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    }

    const work: AccountEntry = {
        id: "acc_work",
        name: "work",
        provider: PROVIDER,
        enabled: true,
        billing: { mode: "subscription" },
        credentials: {},
        useEnvApiKey: false,
    };

    /** Two consecutive failures: enough to block for five minutes. */
    async function blockAccount(failedAt: number): Promise<void> {
        await savePollGate(
            PROVIDER,
            recordFailure(recordFailure({}, "work", "session expired", failedAt), "work", "session expired", failedAt)
        );
    }

    function plugin(args: { polled: string[]; stamp: number | undefined; result?: () => Promise<never> }): UsagePlugin {
        const usage: AccountUsageFeature = {
            poll: (target) => {
                args.polled.push(target.name);

                if (args.result) {
                    return args.result();
                }

                return Promise.resolve({
                    provider: PROVIDER,
                    accountId: target.id,
                    accountName: target.name,
                    fetchedAt: new Date().toISOString(),
                    limits: [{ key: "weekly", label: "Weekly", kind: "weekly" as const, percentUsed: 4 }],
                });
            },
            credentialStamp: () => Promise.resolve(args.stamp),
        };
        const features: AccountFeatures = {
            presentation: { displayName: "Fake", alias: "fake", limitOrder: [], prominentLimits: [] },
            logoutTargets: [],
            usage,
        };

        return {
            plugin: {
                id: PROVIDER,
                kind: "subscription",
                capabilities: new Set(),
                credential: { fields: ["authFile"], envKeys: [] },
                bind: () => Promise.reject(new Error("the fake plugin is never bound")),
                accounts: features,
            },
            features,
            usage,
        };
    }

    test("an auth file rewritten after the failure is polled again immediately", async () => {
        useTempHome();
        const failedAt = Date.now();
        await blockAccount(failedAt);
        const polled: string[] = [];

        const snapshots = await __fetchProviderSnapshots(
            plugin({ polled, stamp: failedAt + 60_000 }),
            [work],
            {},
            new Set()
        );

        expect(polled).toEqual(["work"]);
        expect(snapshots[0].error).toBeUndefined();
        expect((await loadPollGate(PROVIDER)).work).toBeUndefined();
    });

    // The control that makes the test above mean something: without a newer stamp the
    // account must stay suppressed, or the gate would have stopped working entirely.
    test("an auth file older than the failure stays blocked", async () => {
        useTempHome();
        const failedAt = Date.now();
        await blockAccount(failedAt);
        const polled: string[] = [];

        const snapshots = await __fetchProviderSnapshots(
            plugin({ polled, stamp: failedAt - 60_000 }),
            [work],
            {},
            new Set()
        );

        expect(polled).toEqual([]);
        expect(snapshots[0].error).toBe("session expired");
        expect((await loadPollGate(PROVIDER)).work.failures).toBe(2);
    });

    // The suppressed row used to carry the raw reason and nothing else, so the TUI and the
    // dashboard replayed an old error with no hint that the account was merely paused.
    test("a suppressed snapshot says when the block lifts and how many failures bought it", async () => {
        useTempHome();
        const failedAt = Date.now();
        await blockAccount(failedAt);

        const [snapshot] = await __fetchProviderSnapshots(
            plugin({ polled: [], stamp: failedAt - 60_000 }),
            [work],
            {},
            new Set()
        );

        expect(snapshot.blocked?.failures).toBe(2);
        expect(Date.parse(snapshot.blocked?.until ?? "")).toBe(failedAt + 5 * 60_000);
        expect(formatBlockedNotice(snapshot, failedAt)).toContain("(2 failures): session expired");
    });

    // Issue #378: an account that holds no credential cannot be polled, so it is neither a
    // failure nor a block. The row names the command to run, and any backoff an earlier
    // round earned by polling it anyway is let go, so the fix shows at once.
    test("an account with no credential is not polled, not counted, and names the login to run", async () => {
        useTempHome();
        const failedAt = Date.now();
        await blockAccount(failedAt);
        const polled: string[] = [];
        const built = plugin({ polled, stamp: undefined });
        built.usage.missingCredential = (target) => ({
            message: `Account "${target.name}" holds nothing.`,
            remedy: `tools fake login ${target.name}`,
        });

        const [snapshot] = await __fetchProviderSnapshots(built, [work], {}, new Set());

        expect(polled).toEqual([]);
        expect(snapshot.needsLogin).toEqual({ remedy: "tools fake login work" });
        expect(snapshot.error).toBe('Account "work" holds nothing. Run: tools fake login work');
        expect(snapshot.blocked).toBeUndefined();
        expect(formatNeedsLoginNotice(snapshot)).toBe("needs login: tools fake login work");
        expect(await loadPollGate(PROVIDER)).toEqual({});
    });

    // Negative control: a row that failed for real this round must NOT be dressed up as a
    // pause, or a live outage would read as "come back later".
    test("a live failure carries no block", async () => {
        useTempHome();
        const [snapshot] = await __fetchProviderSnapshots(
            plugin({ polled: [], stamp: undefined, result: () => Promise.reject(new Error("Usage API 401")) }),
            [work],
            {},
            new Set()
        );

        expect(snapshot.blocked).toBeUndefined();
        expect(formatBlockedNotice(snapshot)).toBeNull();
    });

    // A repaired account must not inherit the streak the dead one earned, or its very next
    // failure would jump straight back to a long block.
    test("a released account starts its ladder from zero when it fails again", async () => {
        useTempHome();
        const failedAt = Date.now();
        await blockAccount(failedAt);
        const polled: string[] = [];

        await __fetchProviderSnapshots(
            plugin({
                polled,
                stamp: failedAt + 60_000,
                result: () => Promise.reject(new Error("Usage API 401: unauthorized")),
            }),
            [work],
            {},
            new Set()
        );

        const gate = await loadPollGate(PROVIDER);
        expect(polled).toEqual(["work"]);
        expect(gate.work.failures).toBe(1);
        expect(blockedEntry(gate, "work", Date.now())).toBeNull();
    });

    test("a plugin with no credentialStamp keeps the block exactly as before", async () => {
        useTempHome();
        const failedAt = Date.now();
        await blockAccount(failedAt);
        const polled: string[] = [];
        const entry = plugin({ polled, stamp: undefined });

        const snapshots = await __fetchProviderSnapshots(entry, [work], {}, new Set());

        expect(polled).toEqual([]);
        expect(snapshots[0].error).toBe("session expired");
    });
});
