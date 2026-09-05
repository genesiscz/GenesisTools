import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { queryUsage } from "@genesiscz/utils/ai/usage";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { env } from "@genesiscz/utils/env";
import { removeDbFile } from "@genesiscz/utils/fs";
import { recordSnapshots } from "./record";
import type { AccountUsageSnapshot } from "./types";

/**
 * `recordSnapshots` mirrors newly-changed limit windows into the shared usage layer. The
 * limits store stays the source of truth for windows; these assertions are about the
 * mirror being additive, deduped, provider-neutral, and never emitted for stale data.
 *
 * The `app` label is `ai-usage`, not `claude`: since every provider writes through this
 * one function, a claude-only label would have made a codex window unfindable.
 */

const APP = "ai-usage";

let home: string;
let dbPath: string;
let dbCounter = 0;

function anthropic(name: string, fiveHour: number): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: "",
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [
            {
                key: "five_hour",
                label: "Session (5h)",
                kind: "session",
                percentUsed: fiveHour,
                resetsAt: "2026-03-04T12:00:00.000Z",
            },
            { key: "seven_day", label: "Weekly (all)", kind: "weekly", percentUsed: 0, resetsAt: undefined },
        ],
    };
}

function codex(name: string, primary: number): AccountUsageSnapshot {
    return {
        provider: "openai-sub",
        accountId: `acc_${name}`,
        accountName: name,
        fetchedAt: new Date().toISOString(),
        limits: [{ key: "primary", label: "Session", kind: "session", percentUsed: primary }],
    };
}

function todayWindow(): { from: string; to: string } {
    const now = Date.now();

    return { from: new Date(now - 60_000).toISOString(), to: new Date(now + 60_000).toISOString() };
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gt-usage-mirror-"));
    env.testing.set("GENESIS_TOOLS_HOME", home);
    AiConfigStore.invalidate();

    // `recordSnapshots` builds `new UsageLimitsDb()` with no path, which resolves the
    // process-wide ClaudeDatabase singleton. That singleton's default path is built from
    // `homedir()` and does NOT follow GENESIS_TOOLS_HOME (src/utils/claude/database.ts),
    // so priming it here is what keeps this suite out of the real usage history.
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

describe("recordSnapshots → shared usage layer", () => {
    test("mirrors each changed window as a bucket-snapshot event", async () => {
        await recordSnapshots([anthropic("work", 42)]);

        const events = queryUsage({ ...todayWindow(), app: APP }).events;
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

    test("a codex window mirrors under its own provider", async () => {
        await recordSnapshots([codex("side", 41.5)]);

        const events = queryUsage({ ...todayWindow(), app: APP }).events;
        const primary = events.find((event) => event.meta?.bucket === "primary");

        expect(primary?.provider).toBe("openai-sub");
        expect(primary?.accountId).toBe("acc_side");
        expect(primary?.meta).toMatchObject({ kind: "bucket-snapshot", utilization: 41.5 });
    });

    test("carries no tokens — a limit window is a percentage, not spend", async () => {
        await recordSnapshots([anthropic("work", 42)]);

        const total = queryUsage({ ...todayWindow(), app: APP }).total;

        expect(total.inputTokens).toBe(0);
        expect(total.outputTokens).toBe(0);
    });

    test("emits only on change, so a 30s poll loop cannot flood the log", async () => {
        await recordSnapshots([anthropic("work", 42)]);
        const afterFirst = queryUsage({ ...todayWindow(), app: APP }).total.events;

        await recordSnapshots([anthropic("work", 42)]);
        const afterRepeat = queryUsage({ ...todayWindow(), app: APP }).total.events;

        expect(afterFirst).toBeGreaterThan(0);
        expect(afterRepeat).toBe(afterFirst);

        await recordSnapshots([anthropic("work", 43)]);

        expect(queryUsage({ ...todayWindow(), app: APP }).total.events).toBe(afterFirst + 1);
    });

    test("skips stale entries, exactly as the history write does", async () => {
        await recordSnapshots([
            { ...anthropic("work", 42), stale: { lastSuccessAt: new Date().toISOString(), reason: "429" } },
        ]);

        expect(queryUsage({ ...todayWindow(), app: APP }).total.events).toBe(0);
    });

    test("keys events by account name when the snapshot carries no account id", async () => {
        await recordSnapshots([anthropic("work", 42)]);

        const events = queryUsage({ ...todayWindow(), app: APP }).events;

        expect(events[0].accountId).toBe("work");
    });
});
