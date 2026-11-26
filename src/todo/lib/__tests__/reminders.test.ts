import { describe, expect, it } from "bun:test";
import { alertsForStart, parseReminders, parseReminderTime } from "../reminders";

const FIXED_NOW = new Date("2026-04-01T12:00:00.000Z");

describe("parseReminderTime", () => {
    it("parses minutes (30m)", () => {
        const result = parseReminderTime("30m", FIXED_NOW);
        expect(result).toBe("2026-04-01T12:30:00.000Z");
    });

    it("parses hours (24h)", () => {
        const result = parseReminderTime("24h", FIXED_NOW);
        expect(result).toBe("2026-04-02T12:00:00.000Z");
    });

    it("parses days (3d)", () => {
        const result = parseReminderTime("3d", FIXED_NOW);
        expect(result).toBe("2026-04-04T12:00:00.000Z");
    });

    it("parses weeks (1w)", () => {
        const result = parseReminderTime("1w", FIXED_NOW);
        expect(result).toBe("2026-04-08T12:00:00.000Z");
    });

    it("is case-insensitive for units", () => {
        const result = parseReminderTime("2H", FIXED_NOW);
        expect(result).toBe("2026-04-01T14:00:00.000Z");
    });

    it("parses absolute ISO datetime", () => {
        const result = parseReminderTime("2026-04-02T10:00:00.000Z");
        expect(result).toBe("2026-04-02T10:00:00.000Z");
    });

    it("parses absolute YYYY-MM-DD HH:MM format", () => {
        const result = parseReminderTime("2026-04-02 10:00");
        const parsed = new Date(result);
        expect(parsed.getFullYear()).toBe(2026);
        expect(parsed.getMonth()).toBe(3);
        expect(parsed.getDate()).toBe(2);
    });

    it("throws on invalid input", () => {
        expect(() => parseReminderTime("")).toThrow();
        expect(() => parseReminderTime("abc")).toThrow();
        expect(() => parseReminderTime("10x")).toThrow();
    });
});

describe("parseReminders", () => {
    it("maps array of strings to TodoReminder objects", () => {
        const reminders = parseReminders(["24h", "2026-04-05T09:00:00.000Z"]);

        expect(reminders).toHaveLength(2);
        expect(reminders[0].at).toBeTruthy();
        expect(reminders[0].synced).toBeNull();
        expect(reminders[1].at).toBe("2026-04-05T09:00:00.000Z");
        expect(reminders[1].synced).toBeNull();
    });

    it("returns empty array for empty input", () => {
        expect(parseReminders([])).toEqual([]);
    });
});

describe("alertsForStart", () => {
    const START = "2026-11-27T12:00:00.000Z";
    const MOVED = "2026-11-28T09:00:00.000Z";

    it("gives a todo with a start and no alert one alert at the start", () => {
        expect(alertsForStart({ reminders: [], at: START })).toEqual([
            { at: START, label: "event start", synced: null },
        ]);
    });

    it("leaves a todo with no start alone", () => {
        expect(alertsForStart({ reminders: [] })).toEqual([]);
    });

    it("adds a timed alert beside a receipt from an untimed reminder sync", () => {
        const receipt = { at: "", synced: "reminders" as const, syncId: "REM-1" };
        const alerts = alertsForStart({ reminders: [receipt], at: START });
        expect(alerts).toEqual([receipt, { at: START, label: "event start", synced: null }]);
        expect(alertsForStart({ reminders: alerts, previousAt: START, at: START })).toEqual(alerts);
    });

    it("keeps the alerts a user gave", () => {
        const given = [{ at: "2026-11-27T11:00:00.000Z", synced: null }];

        expect(alertsForStart({ reminders: given, previousAt: START, at: START })).toEqual(given);
    });

    it("moves the automatic alert with the start while no platform owns it", () => {
        const automatic = alertsForStart({ reminders: [], at: START });

        expect(alertsForStart({ reminders: automatic, previousAt: START, at: MOVED })).toEqual([
            { at: MOVED, label: "event start", synced: null },
        ]);
    });

    it("negative control: an alert an event already carries stays where the event has it", () => {
        const owned = [{ at: START, label: "event start", synced: "calendar" as const, syncId: "EVT-1" }];

        expect(alertsForStart({ reminders: owned, previousAt: START, at: MOVED })).toEqual(owned);
    });
});
