import { describe, expect, test } from "bun:test";
import type { ReminderInfo } from "@genesiscz/darwinkit";
import { groupReminders } from "./grouping";

function reminder(partial: Partial<ReminderInfo> & Pick<ReminderInfo, "identifier" | "title">): ReminderInfo {
    return {
        is_completed: false,
        priority: 0,
        list_identifier: "list-1",
        list_title: "GenesisTools",
        has_alarms: false,
        alarms: [],
        is_flagged: false,
        ...partial,
    };
}

describe("groupReminders", () => {
    test("groups by bucket list title", () => {
        const items = [
            reminder({ identifier: "a", title: "A", list_identifier: "l1", list_title: "Work" }),
            reminder({ identifier: "b", title: "B", list_identifier: "l2", list_title: "Home" }),
        ];

        const groups = groupReminders(items, "bucket");

        expect(groups.map((g) => g.label).sort()).toEqual(["Home", "Work"]);
    });

    test("groups date-priority with compound labels", () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(12, 0, 0, 0);

        const items = [
            reminder({
                identifier: "a",
                title: "High",
                due_date: tomorrow.toISOString(),
                priority: 1,
            }),
        ];

        const groups = groupReminders(items, "date-priority");

        expect(groups.some((g) => g.label.includes("Tomorrow") && g.label.includes("High"))).toBe(true);
    });
});
