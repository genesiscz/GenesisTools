import { describe, expect, test } from "bun:test";
import { computeAssignmentPeriods, computeStatePeriods } from "@app/azure-devops/history";
import type { WorkItemUpdate } from "@app/azure-devops/types";

/**
 * Bug 261311 as the updates API returns it: each `revisedDate` is the moment the NEXT revision
 * replaced the update, and the latest one carries the 9999 sentinel. The real moments sit in
 * `System.ChangedDate`.
 */
function update(rev: number, changed: string, revised: string, fields: WorkItemUpdate["fields"]): WorkItemUpdate {
    return {
        id: rev,
        workItemId: 261311,
        rev,
        revisedBy: { displayName: "Testerová Jana (QT1)" },
        revisedDate: revised,
        fields: { "System.ChangedDate": { newValue: changed }, ...fields },
        url: "",
    };
}

const UPDATES: WorkItemUpdate[] = [
    update(25, "2026-08-02T21:21:00Z", "2026-09-01T12:51:00Z", {
        "System.State": { oldValue: "Development", newValue: "Testing" },
        "System.AssignedTo": { newValue: { displayName: "Testerová Jana (QT1)" } },
    }),
    update(31, "2026-08-05T13:23:48Z", "2026-09-17T16:33:14Z", {
        "System.State": { oldValue: "Testing", newValue: "Closed" },
    }),
    update(34, "2026-09-17T16:33:14Z", "9999-01-01T00:00:00Z", {
        "System.State": { oldValue: "Closed", newValue: "Development" },
        "System.AssignedTo": { newValue: { displayName: "Vývojář Karel (QT)" } },
    }),
];

describe("computeStatePeriods", () => {
    test("dates every period by the update's changed date, not by revisedDate", () => {
        const periods = computeStatePeriods(UPDATES);
        expect(periods.map((p) => [p.state, p.startDate, p.endDate])).toEqual([
            ["Testing", "2026-08-02T21:21:00Z", "2026-08-05T13:23:48Z"],
            ["Closed", "2026-08-05T13:23:48Z", "2026-09-17T16:33:14Z"],
            ["Development", "2026-09-17T16:33:14Z", null],
        ]);
    });

    test("falls back to a real revisedDate when the update has no changed date", () => {
        const bare: WorkItemUpdate[] = UPDATES.map((u) => {
            const fields: NonNullable<WorkItemUpdate["fields"]> = {};
            const state = u.fields?.["System.State"];
            if (state) {
                fields["System.State"] = state;
            }

            return { ...u, fields };
        });
        const periods = computeStatePeriods(bare);
        expect(periods[0]?.startDate).toBe("2026-09-01T12:51:00Z");
        expect(periods[2]?.startDate).not.toStartWith("9999");
    });
});

describe("computeAssignmentPeriods", () => {
    test("dates assignments by the changed date too", () => {
        const periods = computeAssignmentPeriods(UPDATES);
        expect(periods.map((p) => [p.assignee, p.startDate, p.endDate])).toEqual([
            ["Testerová Jana (QT1)", "2026-08-02T21:21:00Z", "2026-09-17T16:33:14Z"],
            ["Vývojář Karel (QT)", "2026-09-17T16:33:14Z", null],
        ]);
    });
});
