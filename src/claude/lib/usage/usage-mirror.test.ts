import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { queryUsage } from "@genesiscz/utils/ai/usage";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { env } from "@genesiscz/utils/env";
import { removeDbFile } from "@genesiscz/utils/fs";
import type { AccountUsage } from "./api";
import { recordAll } from "./shared-cache";

/**
 * `recordAll` mirrors newly-changed limit buckets into the shared usage layer.
 * The history DB stays the source of truth for buckets; these assertions are
 * about the mirror being additive, deduped, and never emitted for stale data.
 */

let home: string;
let dbPath: string;
let dbCounter = 0;

function account(name: string, fiveHour: number, sevenDay = 0): AccountUsage {
    return {
        accountName: name,
        label: name,
        usage: {
            five_hour: { utilization: fiveHour, resets_at: "2026-03-04T12:00:00.000Z" },
            seven_day: { utilization: sevenDay, resets_at: null },
        },
    } as AccountUsage;
}

function todayWindow(): { from: string; to: string } {
    const now = Date.now();

    return { from: new Date(now - 60_000).toISOString(), to: new Date(now + 60_000).toISOString() };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-usage-mirror-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();

    // `recordAll` builds `new UsageHistoryDb()` with no path, which resolves the
    // process-wide ClaudeDatabase singleton. That singleton's default path is
    // built from `homedir()` and does NOT follow GENESIS_TOOLS_HOME
    // (src/utils/claude/database.ts:5), so priming it here is what keeps this
    // suite out of the user's real usage history.
    ClaudeDatabase.closeInstance();
    dbPath = join(home, `usage-mirror-${++dbCounter}.sqlite`);
    ClaudeDatabase.getInstance(dbPath);
});

afterEach(() => {
    ClaudeDatabase.closeInstance();
    removeDbFile(dbPath);
    AiConfigStore.invalidate();
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("recordAll → shared usage layer", () => {
    test("mirrors each changed bucket as a bucket-snapshot event", async () => {
        await recordAll([account("martin-max", 42)]);

        const events = queryUsage({ ...todayWindow(), app: "claude" }).events;
        const fiveHour = events.find((event) => event.meta?.bucket === "five_hour");

        expect(fiveHour).toBeDefined();
        expect(fiveHour?.provider).toBe("anthropic-sub");
        expect(fiveHour?.meta).toMatchObject({
            kind: "bucket-snapshot",
            bucket: "five_hour",
            utilization: 42,
            resetsAt: "2026-03-04T12:00:00.000Z",
        });
    });

    test("carries no tokens — a limit bucket is a percentage, not spend", async () => {
        await recordAll([account("martin-max", 42)]);

        const total = queryUsage({ ...todayWindow(), app: "claude" }).total;

        expect(total.inputTokens).toBe(0);
        expect(total.outputTokens).toBe(0);
    });

    test("emits only on change, so a 30s poll loop cannot flood the log", async () => {
        await recordAll([account("martin-max", 42)]);
        const afterFirst = queryUsage({ ...todayWindow(), app: "claude" }).total.events;

        await recordAll([account("martin-max", 42)]);
        const afterRepeat = queryUsage({ ...todayWindow(), app: "claude" }).total.events;

        expect(afterFirst).toBeGreaterThan(0);
        expect(afterRepeat).toBe(afterFirst);

        await recordAll([account("martin-max", 43)]);

        expect(queryUsage({ ...todayWindow(), app: "claude" }).total.events).toBe(afterFirst + 1);
    });

    test("skips stale entries, exactly as the history write does", async () => {
        await recordAll([
            { ...account("martin-max", 42), stale: { lastSuccessAt: Date.now() - 60_000, reason: "429" } },
        ]);

        expect(queryUsage({ ...todayWindow(), app: "claude" }).total.events).toBe(0);
    });

    test("keys events by account name when no matching account id exists", async () => {
        await recordAll([account("martin-max", 42)]);

        const events = queryUsage({ ...todayWindow(), app: "claude" }).events;

        expect(events[0].accountId).toBe("martin-max");
    });
});
