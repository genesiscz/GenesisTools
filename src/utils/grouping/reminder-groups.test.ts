import { describe, expect, test } from "bun:test";
import { groupReminders } from "@app/utils/grouping/reminder-groups";
import type { ReminderInfo } from "@genesiscz/darwinkit";

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
            reminder({ identifier: "a", title: "A", list_identifier: "l1", list_title: "One" }),
            reminder({ identifier: "b", title: "B", list_identifier: "l2", list_title: "Two" }),
        ];
        const groups = groupReminders(items, "bucket");

        expect(groups).toHaveLength(2);
        expect(groups.map((g) => g.label).sort()).toEqual(["One", "Two"]);
    });

    test("nested date-priority groups", () => {
        const items = [
            reminder({ identifier: "a", title: "A", due_date: new Date().toISOString(), priority: 1 }),
            reminder({ identifier: "b", title: "B", due_date: new Date().toISOString(), priority: 9 }),
        ];
        const groups = groupReminders(items, "date-priority");

        expect(groups.length).toBeGreaterThanOrEqual(1);
        expect(groups[0]?.label).toMatch(/Today/);
    });
});
