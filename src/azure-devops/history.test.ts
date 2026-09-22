import { describe, expect, test } from "bun:test";
import { computeAssignmentPeriods, computeStatePeriods } from "@app/azure-devops/history";
import type { WorkItemUpdate } from "@app/azure-devops/types";

/**
 * A bug as the updates API returns it: each `revisedDate` is the moment the NEXT revision
 * replaced the update, and the latest one carries the 9999 sentinel. The real moments sit in
 * `System.ChangedDate`.
 */
function update(rev: number, changed: string, revised: string, fields: WorkItemUpdate["fields"]): WorkItemUpdate {
    return {
        id: rev,
        workItemId: 100001,
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

describe("an update whose moment cannot be recovered", () => {
    /** No `System.ChangedDate`, no `System.AuthorizedDate`, and the 9999 sentinel on `revisedDate`. */
    const undated: WorkItemUpdate = {
        id: 40,
        workItemId: 100001,
        rev: 40,
        revisedBy: { displayName: "Tester One" },
        revisedDate: "9999-01-01T00:00:00Z",
        fields: { "System.State": { oldValue: "Development", newValue: "Testing" } },
        url: "",
    };

    test("does not become a period boundary dated today", () => {
        // The old `|| update.revisedDate` handed the sentinel to sanitizeDate, which replaced
        // it with the CURRENT time, so a revision with no recoverable date was reported as
        // having happened now and matched every date window.
        const periods = computeStatePeriods([...UPDATES, undated]);
        const today = new Date().toISOString().slice(0, 10);

        for (const period of periods) {
            expect(period.startDate.slice(0, 10)).not.toBe(today);
            expect(period.endDate?.slice(0, 10) ?? "").not.toBe(today);
        }
    });

    test("a trailing one still moves the item into its new state", () => {
        // It used to be skipped outright, so the item was reported as still in Development
        // after an update that moved it to Testing.
        const periods = computeStatePeriods([...UPDATES, undated]);
        const last = periods.at(-1);

        expect(last?.state).toBe("Testing");
        expect(last?.endDate).toBeNull();
        expect(last?.startDate).toBe("2026-09-17T16:33:14Z");
    });

    test("a middle one keeps its state as a zero-length period instead of losing it", () => {
        // Closed (dated) -> Blocked (undated) -> Development (dated): the Blocked transition
        // used to vanish. Its span cannot be dated, so it stays with Closed, and Blocked is kept.
        const middle: WorkItemUpdate = {
            ...undated,
            id: 32,
            rev: 32,
            fields: { "System.State": { newValue: "Blocked" } },
        };
        const periods = computeStatePeriods([...UPDATES, middle]);

        expect(periods.map((p) => [p.state, p.startDate, p.endDate])).toEqual([
            ["Testing", "2026-08-02T21:21:00Z", "2026-08-05T13:23:48Z"],
            ["Closed", "2026-08-05T13:23:48Z", "2026-09-17T16:33:14Z"],
            ["Blocked", "2026-09-17T16:33:14Z", "2026-09-17T16:33:14Z"],
            ["Development", "2026-09-17T16:33:14Z", null],
        ]);
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
