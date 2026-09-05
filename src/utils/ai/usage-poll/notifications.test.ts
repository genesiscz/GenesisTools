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
