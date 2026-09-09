import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { Storage } from "@genesiscz/utils/storage/storage";

interface DispatchedEvent {
    app: string;
    title?: string;
    message: string;
    group?: string;
    sound?: string;
}

const dispatched: DispatchedEvent[] = [];

mock.module("@genesiscz/utils/notifications", () => ({
    dispatchNotification: async (event: DispatchedEvent) => {
        dispatched.push(event);
        return true;
    },
}));

const { NotificationManager } = await import("./notifications");

type NotifyConfig = ConstructorParameters<typeof NotificationManager>[0];

function config(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
    return {
        enabled: true,
        inTui: false,
        macos: true,
        sound: "Purr",
        thresholds: { session: [80], weekly: [20] },
        ...overrides,
    };
}

const WINDOW = {
    accountName: "work",
    key: "five_hour",
    kind: "session" as const,
    label: "Session (5h)",
    utilization: 95,
    resetsAt: null,
};

describe("NotificationManager desktop dispatch", () => {
    test("macos false sends no desktop notification", async () => {
        dispatched.length = 0;

        await new NotificationManager(config({ macos: false })).processUsage(WINDOW);

        expect(dispatched).toEqual([]);
    });

    // Negative control: the same crossing still fires when the switch is on, and it
    // carries the dashboard's own sound rather than the global channel default.
    test("macos true sends the alert with the configured sound", async () => {
        dispatched.length = 0;

        await new NotificationManager(config()).processUsage(WINDOW);

        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({ app: "claude", title: "AI Usage Alert", sound: "Purr" });
        expect(dispatched[0].message).toContain("work");
    });

    test("an empty sound falls back to the channel config", async () => {
        dispatched.length = 0;

        await new NotificationManager(config({ sound: "" })).processUsage(WINDOW);

        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].sound).toBeUndefined();
    });

    test("notifications disabled beats everything", async () => {
        dispatched.length = 0;

        await new NotificationManager(config({ enabled: false })).processUsage(WINDOW);

        expect(dispatched).toEqual([]);
    });
});

/**
 * The tracker moved from `Storage("claude-usage")` to `Storage("ai-usage")` with the poll
 * core. With no fallback the first poll after the move restores nothing, counts itself as
 * the first poll ever, and banners every window already over a threshold.
 */
describe("NotificationManager tracker state", () => {
    const cleanups: Array<() => void> = [];

    function useTempHome(): void {
        const home = mkdtempSync(join(tmpdir(), "ai-usage-notify-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);
        cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    }

    async function seed(tool: string, threshold: number): Promise<void> {
        await new Storage(tool).setConfig({
            notificationPollTracker: {
                trackers: { "work:five_hour": { lastNotifiedThreshold: threshold, lastResetEpoch: null } },
                savedAt: new Date().toISOString(),
            },
        });
    }

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) {
            cleanup();
        }

        env.testing.unset("GENESIS_TOOLS_HOME");
    });

    test("restores the thresholds the pre-move store holds", async () => {
        useTempHome();
        dispatched.length = 0;
        await seed("claude-usage", 80);

        const manager = new NotificationManager(config());
        await manager.loadState(new Storage("ai-usage"));
        await manager.processUsage(WINDOW);

        expect(dispatched).toEqual([]);
    });

    // Negative control: once the new store has its own state the old file is ignored, so a
    // stale claude-era threshold cannot suppress a fresh crossing.
    test("the new store wins over the pre-move one", async () => {
        useTempHome();
        dispatched.length = 0;
        await seed("claude-usage", 80);
        await seed("ai-usage", 20);

        const manager = new NotificationManager(config());
        await manager.loadState(new Storage("ai-usage"));
        await manager.processUsage(WINDOW);

        expect(dispatched).toHaveLength(1);
    });

    // Without any saved state at all this IS the first poll, and firing once is correct.
    test("no saved state anywhere still notifies once", async () => {
        useTempHome();
        dispatched.length = 0;

        const manager = new NotificationManager(config());
        await manager.loadState(new Storage("ai-usage"));
        await manager.processUsage(WINDOW);

        expect(dispatched).toHaveLength(1);
    });
});

/**
 * `resetsAt` is a raw provider string: grok forwards `credits.currentPeriod.end` and
 * anthropic forwards `limit.resets_at`, neither validated. `new Date(bad).getTime()` is NaN,
 * and `NaN !== null`, so ONE bad poll overwrote the last known reset time with NaN, and every
 * later `Math.abs(valid - NaN) > …` was false — the window-rollover detector was dead for the
 * life of that bucket. The state is persisted, so it survived restarts too.
 */
describe("NotificationManager rollover with a bad reset time", () => {
    const OLD = "2026-09-01T00:00:00.000Z";
    const NEW = "2026-09-08T00:00:00.000Z";

    /** One `processUsage` per round, exactly as `poll-daemon.ts` drives it. */
    async function rounds(resets: Array<[number, string | null]>): Promise<number> {
        dispatched.length = 0;
        const manager = new NotificationManager(config());

        for (const [utilization, resetsAt] of resets) {
            await manager.processUsage({ ...WINDOW, utilization, resetsAt });
            manager.markFirstPollDone();
        }

        return dispatched.length;
    }

    test("a bad reset time between two good ones still lets the next window notify", async () => {
        const alerts = await rounds([
            [95, OLD],
            [95, "not a date"],
            [5, NEW],
            [95, NEW],
        ]);

        expect(alerts).toBe(2);
    });

    test("negative control: the same rounds with every reset time valid", async () => {
        const alerts = await rounds([
            [95, OLD],
            [95, OLD],
            [5, NEW],
            [95, NEW],
        ]);

        expect(alerts).toBe(2);
    });

    test("negative control: without a rollover there is no second alert", async () => {
        const alerts = await rounds([
            [95, OLD],
            [95, "not a date"],
            [5, OLD],
            [95, OLD],
        ]);

        expect(alerts).toBe(1);
    });
});
