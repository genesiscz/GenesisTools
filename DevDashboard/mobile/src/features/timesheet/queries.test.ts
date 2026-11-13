import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fixtureDashboardClient } from "@/api/fixture-wire";
import { MOCK_TIMESHEET } from "@/api/fixtures/timesheet";
import { acceptedForRevision, allAccepted, dayLine, fillWeek, hours, localDay, weekQuery } from "@/features/timesheet/queries";

/** The phone's notification center and keychain, as the reminder sees them. */
const device = {
    granted: false,
    canAskAgain: false,
    scheduleFails: false,
    scheduled: new Set<string>(),
    secure: new Map<string, string>(),
};

mock.module("expo-notifications", () => ({
    SchedulableTriggerInputTypes: { WEEKLY: "weekly" },
    getPermissionsAsync: async () => ({ granted: device.granted, canAskAgain: device.canAskAgain }),
    requestPermissionsAsync: async () => ({ granted: device.granted, canAskAgain: false }),
    getAllScheduledNotificationsAsync: async () => [...device.scheduled].map((identifier) => ({ identifier })),
    cancelScheduledNotificationAsync: async (identifier: string) => {
        device.scheduled.delete(identifier);
    },
    scheduleNotificationAsync: async (request: { identifier: string }) => {
        if (device.scheduleFails) {
            throw new Error("scheduling refused");
        }

        device.scheduled.add(request.identifier);
        return request.identifier;
    },
}));
mock.module("expo-secure-store", () => ({
    getItemAsync: async (key: string) => device.secure.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
        device.secure.set(key, value);
    },
}));

const { ensureDefaultReminder, setReminder } = await import("@/features/timesheet/reminder");

describe("the Friday reminder", () => {
    beforeEach(() => {
        Object.assign(device, { granted: false, canAskAgain: false, scheduleFails: false });
        device.scheduled.clear();
        device.secure.clear();
    });

    it("stays undecided while it cannot be scheduled, so the default turns it on once notifications are allowed", async () => {
        await expect(ensureDefaultReminder()).resolves.toBe(false);
        expect(device.secure.size).toBe(0);

        device.granted = true;
        device.scheduleFails = true;
        await expect(setReminder(true)).resolves.toBe(false);
        expect(device.secure.size).toBe(0);

        device.scheduleFails = false;
        await expect(ensureDefaultReminder()).resolves.toBe(true);
        expect(device.secure.size).toBe(1);
        await expect(setReminder(false)).resolves.toBe(false);
        await expect(ensureDefaultReminder()).resolves.toBe(false);
    });
});

describe("the Friday timesheet", () => {
    it("requires a new review after a stale fill is refused and the same task codes refresh", () => {
        const review = { revision: MOCK_TIMESHEET.revision, codes: new Set(MOCK_TIMESHEET.rows.map((row) => row.code)) };
        expect(allAccepted(MOCK_TIMESHEET, acceptedForRevision(MOCK_TIMESHEET, review))).toBe(true);
        const refreshed = { ...MOCK_TIMESHEET, revision: "new-revision" };
        expect(allAccepted(refreshed, acceptedForRevision(refreshed, review))).toBe(false);
        const next = { revision: refreshed.revision, codes: new Set([refreshed.rows[0]!.code]) };
        expect(allAccepted(refreshed, acceptedForRevision(refreshed, next))).toBe(false);
    });

    it("reads the week and sends the fill with the revision it showed", async () => {
        const week = await weekQuery(fixtureDashboardClient, "2026-09-30").queryFn?.({} as never);
        const receipt = await fillWeek(fixtureDashboardClient, {
            date: "2026-09-30",
            timesheetId: 9001,
            revision: "fixture-rev",
            idempotencyKey: "k1",
        });

        expect(week).toEqual(MOCK_TIMESHEET);
        expect(receipt.filled).toBe(false);
    });

    it("fills only after every row was accepted, and words the hours", () => {
        expect(allAccepted(MOCK_TIMESHEET, new Set(["T-100"]))).toBe(false);
        expect(allAccepted(MOCK_TIMESHEET, new Set(["T-100", "T-200"]))).toBe(true);
        expect(allAccepted(null, new Set())).toBe(false);
        expect(hours(450)).toBe("7.50 h");
        expect(hours(60)).toBe("1 h");
        expect(dayLine(MOCK_TIMESHEET.rows[0])).toBe("Tue 4 h · Wed 3.50 h");
        expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
    });
});
