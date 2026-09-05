import { describe, expect, mock, test } from "bun:test";

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
