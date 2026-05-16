import { describe, expect, test } from "bun:test";
import { ReminderPriority } from "@app/utils/macos/apple-reminders";
import { mapPriority } from "./service";

describe("mapPriority", () => {
    test("maps each level to the matching ReminderPriority value", () => {
        expect(mapPriority("none")).toBe(ReminderPriority.none);
        expect(mapPriority("low")).toBe(ReminderPriority.low);
        expect(mapPriority("medium")).toBe(ReminderPriority.medium);
        expect(mapPriority("high")).toBe(ReminderPriority.high);
    });

    test("returns numeric priority values", () => {
        expect(typeof mapPriority("high")).toBe("number");
    });
});
