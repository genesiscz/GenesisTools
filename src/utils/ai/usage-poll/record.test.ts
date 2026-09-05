import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { queryUsage } from "@genesiscz/utils/ai/usage";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { env } from "@genesiscz/utils/env";
import { removeDbFile } from "@genesiscz/utils/fs";
import { UsageLimitsDb } from "./limits-db";
import { recordSnapshots } from "./record";
import type { AccountUsageSnapshot } from "./types";

let home: string;
let dbPath: string;
let dbCounter = 0;
let db: UsageLimitsDb;

function codexSnapshot(name: string, primary: number): AccountUsageSnapshot {
    return {
        provider: "openai-sub",
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [
            {
                key: "primary",
                label: "5h",
                kind: "session",
                percentUsed: primary,
                resetsAt: "2026-09-04T20:00:00.000Z",
            },
            {
                key: "secondary",
                label: "Weekly",
                kind: "weekly",
                percentUsed: 12,
            },
        ],
    };
}

function grokSnapshot(name: string): AccountUsageSnapshot {
    return {
        provider: "grok-sub",
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [
            {
                key: "monthly",
                label: "Monthly",
                kind: "credit",
                percentUsed: 30,
                money: { usedMinor: 900, limitMinor: 3000, currency: "USD", exponent: 2 },
            },
        ],
    };
}

/**
 * The anthropic `extra_usage` window, which is the one that carries a configured spend cap.
 * `capMinor` / `capCurrency` / `limitExponent` are what `normalizeSpend` reads out of
 * `raw.cap.money` and `raw.limit.exponent`.
 */
function cappedCreditSnapshot(name: string): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [
            {
                key: "extra_usage",
                label: "Extra usage",
                kind: "credit",
                percentUsed: 8,
                severity: "ok",
                isActive: true,
                money: {
                    usedMinor: 1234,
                    limitMinor: 15000,
                    currency: "EUR",
                    exponent: 2,
                    limitExponent: 2,
                    capMinor: 15000,
                    capCurrency: "EUR",
                },
            },
        ],
    };
}

function todayWindow(): { from: string; to: string } {
    const now = Date.now();
    return { from: new Date(now - 60_000).toISOString(), to: new Date(now + 60_000).toISOString() };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-usage-record-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();

    ClaudeDatabase.closeInstance();
    dbPath = join(home, `usage-record-${++dbCounter}.sqlite`);
    ClaudeDatabase.getInstance(dbPath);
    db = new UsageLimitsDb();
});

afterEach(() => {
    ClaudeDatabase.closeInstance();
    removeDbFile(dbPath);
    AiConfigStore.invalidate();
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("recordSnapshots", () => {
    test("writes one limits row per window, tagged with the provider", async () => {
        await recordSnapshots([codexSnapshot("work", 44)], db);

        expect(db.getLatest("work", "primary", "openai-sub")).toMatchObject({
            utilization: 44,
            provider: "openai-sub",
            accountId: "acc_work",
            kind: "session",
        });
        expect(db.getLatest("work", "secondary", "openai-sub")?.utilization).toBe(12);
        // A codex row is invisible to an anthropic-scoped read.
        expect(db.getLatest("work", "primary", "anthropic-sub")).toBeNull();
    });

    test("a credit window keeps its money columns", async () => {
        await recordSnapshots([grokSnapshot("personal")], db);

        expect(db.getLatest("personal", "monthly", "grok-sub")).toMatchObject({
            kind: "credit",
            moneyUsedMinor: 900,
            moneyLimitMinor: 3000,
            moneyCurrency: "USD",
        });
    });

    test("mirrors each changed window into the call log as a bucket-snapshot event", async () => {
        await recordSnapshots([codexSnapshot("work", 44)], db);

        const events = queryUsage({ ...todayWindow(), app: "ai-usage" }).events;
        const primary = events.find((event) => event.meta?.bucket === "primary");

        expect(primary?.provider).toBe("openai-sub");
        expect(primary?.accountId).toBe("acc_work");
        expect(primary?.meta).toMatchObject({ kind: "bucket-snapshot", bucket: "primary", utilization: 44 });
    });

    test("carries no tokens — a limit window is a percentage, not spend", async () => {
        await recordSnapshots([codexSnapshot("work", 44)], db);

        const total = queryUsage({ ...todayWindow(), app: "ai-usage" }).total;

        expect(total.inputTokens).toBe(0);
        expect(total.outputTokens).toBe(0);
    });

    test("emits only on change, so a 30s poll loop cannot flood the log", async () => {
        await recordSnapshots([codexSnapshot("work", 44)], db);
        const afterFirst = queryUsage({ ...todayWindow(), app: "ai-usage" }).total.events;

        await recordSnapshots([codexSnapshot("work", 44)], db);

        expect(queryUsage({ ...todayWindow(), app: "ai-usage" }).total.events).toBe(afterFirst);

        await recordSnapshots([codexSnapshot("work", 45)], db);

        expect(queryUsage({ ...todayWindow(), app: "ai-usage" }).total.events).toBe(afterFirst + 1);
    });

    test("skips stale and errored snapshots", async () => {
        await recordSnapshots(
            [
                { ...codexSnapshot("work", 44), stale: { lastSuccessAt: "2026-09-04T17:00:00.000Z", reason: "429" } },
                { ...codexSnapshot("personal", 44), error: "app-server: not logged in" },
            ],
            db
        );

        expect(db.getLatest("work", "primary", "openai-sub")).toBeNull();
        expect(db.getLatest("personal", "primary", "openai-sub")).toBeNull();
        expect(queryUsage({ ...todayWindow(), app: "ai-usage" }).total.events).toBe(0);
    });

    /**
     * The spend row is the money series, and the pre-campaign writer filled its cap columns
     * straight from `normalizeSpend`. The window carrier had nowhere to hold a cap, so both
     * columns were written as null on every new row.
     */
    test("a capped credit window lands its cap and its limit exponent", async () => {
        await recordSnapshots([cappedCreditSnapshot("shop")], db);

        expect(db.getLatestSpend("shop", "anthropic-sub")).toMatchObject({
            used_minor: 1234,
            used_currency: "EUR",
            used_exponent: 2,
            limit_minor: 15000,
            limit_exponent: 2,
            cap_minor: 15000,
            cap_currency: "EUR",
            percent: 8,
            enabled: true,
        });
    });

    // Negative control: a provider that reports no cap still writes null, as before.
    test("a credit window with no cap still writes null cap columns", async () => {
        await recordSnapshots([grokSnapshot("side")], db);

        expect(db.getLatestSpend("side", "grok-sub")).toMatchObject({
            used_minor: 900,
            limit_minor: 3000,
            // No limitExponent on the window, so the used exponent stands in.
            limit_exponent: 2,
            cap_minor: null,
            cap_currency: null,
        });
    });
});
