import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    __resetLegacyCacheStore,
    type LegacyAccountInput,
    legacyUsageSharedPath,
    projectLegacyUsageShared,
    readSnapshotsCache,
    snapshotsCachePath,
    writeLegacyUsageShared,
    writeSnapshotsCache,
} from "./legacy-cache";
import { __resetUsagePollStorage } from "./storage";
import type { AccountUsageSnapshot } from "./types";

const cleanups: Array<() => void> = [];

function useTempHome(): void {
    const home = mkdtempSync(join(tmpdir(), "ai-usage-legacy-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    __resetLegacyCacheStore();
    __resetUsagePollStorage();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    env.testing.unset("GENESIS_TOOLS_HOME");
    __resetLegacyCacheStore();
    __resetUsagePollStorage();
});

/** The shape the Swift `UsageCacheReader` decodes (spec 6.4), with invented account names. */
function anthropicAccount(name: string): LegacyAccountInput {
    return {
        accountName: name,
        label: name,
        subscriptionPlan: "max",
        subscriptionStatus: "active",
        subscriptionCreatedAt: "2026-01-02T03:04:05.000Z",
        refreshExpiresAt: 1_800_000_000_000,
        orgBlocked: false,
        usage: {
            five_hour: { utilization: 42, resets_at: "2026-09-04T20:00:00.000Z" },
            seven_day: { utilization: 7, resets_at: null },
            limits: [
                {
                    kind: "session",
                    percent: 42,
                    severity: "normal",
                    resets_at: "2026-09-04T20:00:00.000Z",
                    is_active: true,
                    scope: null,
                },
            ],
        },
    };
}

describe("projectLegacyUsageShared", () => {
    test("keeps every field the Swift decoder reads", () => {
        const projected = projectLegacyUsageShared([anthropicAccount("work")], 1_757_000_000_000);

        expect(projected).toEqual({
            fetchedAt: 1_757_000_000_000,
            accounts: [anthropicAccount("work")],
        });
    });

    test("drops a nameless row rather than making the whole file undecodable", () => {
        const nameless = { ...anthropicAccount("personal"), accountName: "" };

        const projected = projectLegacyUsageShared([anthropicAccount("work"), nameless], 1);

        expect(projected.accounts.map((a) => a.accountName)).toEqual(["work"]);
    });

    test("an error row with no usage survives, so a dead account still renders", () => {
        const projected = projectLegacyUsageShared(
            [{ accountName: "shop", error: "Usage API 401: unauthorized", orgBlocked: true }],
            1
        );

        expect(projected.accounts[0]).toEqual({
            accountName: "shop",
            error: "Usage API 401: unauthorized",
            orgBlocked: true,
        });
    });

    test("stale info round-trips with its epoch-ms timestamp", () => {
        const projected = projectLegacyUsageShared(
            [{ ...anthropicAccount("work"), stale: { lastSuccessAt: 1_756_999_000_000, reason: "429" } }],
            2
        );

        expect(projected.accounts[0].stale).toEqual({ lastSuccessAt: 1_756_999_000_000, reason: "429" });
    });
});

describe("writeLegacyUsageShared", () => {
    test("writes raw JSON at the path the Genesis app reads", async () => {
        useTempHome();

        await writeLegacyUsageShared([anthropicAccount("work")], 1_757_000_000_000);

        const path = legacyUsageSharedPath();
        expect(path.endsWith(join(".genesis-tools", "claude-usage", "cache", "usage-shared"))).toBe(true);

        const raw = SafeJSON.parse(await Bun.file(path).text()) as { fetchedAt: number; accounts: unknown[] };
        expect(raw.fetchedAt).toBe(1_757_000_000_000);
        expect(raw.accounts).toHaveLength(1);
    });
});

describe("writeSnapshotsCache", () => {
    function snapshot(provider: string, name: string): AccountUsageSnapshot {
        return {
            provider,
            accountId: `acc_${name}`,
            accountName: name,
            fetchedAt: "2026-09-04T18:00:00.000Z",
            limits: [{ key: "monthly", label: "Monthly", kind: "credit", percentUsed: 30 }],
            native: { secret: "provider-private payload" },
        };
    }

    test("writes the per-provider object with alias, displayName and prominent", async () => {
        useTempHome();

        await writeSnapshotsCache(
            {
                "grok-sub": {
                    alias: "grok",
                    displayName: "Grok",
                    prominent: ["monthly"],
                    accounts: [snapshot("grok-sub", "work")],
                },
            },
            new Date("2026-09-04T18:00:01.000Z")
        );

        const cache = await readSnapshotsCache();

        expect(cache?.fetchedAt).toBe("2026-09-04T18:00:01.000Z");
        expect(cache?.providers["grok-sub"]).toMatchObject({
            alias: "grok",
            displayName: "Grok",
            prominent: ["monthly"],
        });
        expect(cache?.providers["grok-sub"].accounts[0].accountName).toBe("work");
    });

    test("a write for one provider keeps the slices the file already holds", async () => {
        useTempHome();

        await writeSnapshotsCache({
            "grok-sub": {
                alias: "grok",
                displayName: "Grok",
                prominent: ["monthly"],
                accounts: [snapshot("grok-sub", "work")],
            },
        });
        await writeSnapshotsCache({
            "anthropic-sub": {
                alias: "claude",
                displayName: "Claude",
                prominent: ["five_hour"],
                accounts: [snapshot("anthropic-sub", "personal")],
            },
        });
        await writeSnapshotsCache({
            "grok-sub": {
                alias: "grok",
                displayName: "Grok",
                prominent: ["monthly"],
                accounts: [snapshot("grok-sub", "shop")],
            },
        });

        const cache = await readSnapshotsCache();

        expect(Object.keys(cache?.providers ?? {}).sort()).toEqual(["anthropic-sub", "grok-sub"]);
        expect(cache?.providers["anthropic-sub"].accounts[0].accountName).toBe("personal");
        expect(cache?.providers["grok-sub"].accounts.map((s) => s.accountName)).toEqual(["shop"]);
    });

    test("strips native — a provider-private payload never crosses a file boundary", async () => {
        useTempHome();

        await writeSnapshotsCache({
            "grok-sub": {
                alias: "grok",
                displayName: "Grok",
                prominent: ["monthly"],
                accounts: [snapshot("grok-sub", "personal")],
            },
        });

        const text = await Bun.file(snapshotsCachePath()).text();

        expect(text).not.toContain("provider-private payload");
        expect(text).not.toContain('"native"');
    });

    // Negative control: a grok snapshot must never reach the claude-only legacy file.
    test("the legacy file is not written by the all-provider writer", async () => {
        useTempHome();

        await writeSnapshotsCache({
            "grok-sub": {
                alias: "grok",
                displayName: "Grok",
                prominent: ["monthly"],
                accounts: [snapshot("grok-sub", "work")],
            },
        });

        expect(await Bun.file(legacyUsageSharedPath()).exists()).toBe(false);
    });
});
