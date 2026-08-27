import { describe, expect, test } from "bun:test";
import {
    buildSprintWiql,
    mapSprintRow,
    type SprintRow,
    sortByBacklogOrder,
    sortById,
    sumTaskEffort,
} from "@app/azure-devops/lib/sprint";

function row(overrides: Partial<SprintRow> & { id: number }): SprintRow {
    return {
        type: "Task",
        title: "t",
        state: "New",
        assignedTo: "Alice Example",
        completedWork: 0,
        remainingWork: 0,
        order: null,
        changedDate: "2026-08-20T10:00:00Z",
        iterationPath: "Contoso\\Sprint 17",
        ...overrides,
    };
}

describe("buildSprintWiql", () => {
    test("uses an explicit IterationPath predicate, never @CurrentIteration", () => {
        const wiql = buildSprintWiql({ iterationPath: "Contoso\\Sprint 17" });
        expect(wiql).toContain("[System.IterationPath] = 'Contoso\\Sprint 17'");
        expect(wiql).not.toContain("@CurrentIteration");
    });

    test("backslashes in the path are passed through verbatim", () => {
        const wiql = buildSprintWiql({ iterationPath: "Proj\\Sub\\Sprint 1" });
        expect(wiql).toContain("'Proj\\Sub\\Sprint 1'");
        expect(wiql).not.toContain("\\\\");
    });

    test("a single quote in the path is doubled so the literal stays closed", () => {
        const wiql = buildSprintWiql({ iterationPath: "Proj\\Sprint O'Brien" });
        expect(wiql).toContain("'Proj\\Sprint O''Brien'");
    });

    test("@Me is emitted as a bare macro, not a quoted string", () => {
        const wiql = buildSprintWiql({ iterationPath: "Proj\\S1", assignedTo: "@Me" });
        expect(wiql).toContain("[System.AssignedTo] = @Me");
        expect(wiql).not.toContain("'@Me'");
    });

    test("a display name is quoted and escaped", () => {
        const wiql = buildSprintWiql({ iterationPath: "Proj\\S1", assignedTo: "O'Hara Alice" });
        expect(wiql).toContain("[System.AssignedTo] = 'O''Hara Alice'");
    });

    test("no assignee means no AssignedTo clause", () => {
        expect(buildSprintWiql({ iterationPath: "Proj\\S1" })).not.toContain("System.AssignedTo");
    });
});

describe("mapSprintRow", () => {
    test("absent effort fields become 0, not blanks or strings", () => {
        const mapped = mapSprintRow(1, { "System.WorkItemType": "Task" });
        expect(mapped.completedWork).toBe(0);
        expect(mapped.remainingWork).toBe(0);
        expect(typeof mapped.completedWork).toBe("number");
    });

    test("reads effort, identity and rank fields", () => {
        const mapped = mapSprintRow(10007, {
            "System.WorkItemType": "Task",
            "System.Title": "Build the thing",
            "System.State": "In Progress",
            "System.AssignedTo": { displayName: "Alice Example", uniqueName: "alice@example.com" },
            "System.ChangedDate": "2026-08-26T08:00:00Z",
            "Microsoft.VSTS.Scheduling.CompletedWork": 85,
            "Microsoft.VSTS.Scheduling.RemainingWork": 56,
            "Microsoft.VSTS.Common.StackRank": 1999962089,
        });
        expect(mapped).toMatchObject({
            id: 10007,
            type: "Task",
            state: "In Progress",
            assignedTo: "Alice Example",
            completedWork: 85,
            remainingWork: 56,
            order: 1999962089,
        });
    });

    test("falls back to BacklogPriority when StackRank is absent", () => {
        const mapped = mapSprintRow(2, { "Microsoft.VSTS.Common.BacklogPriority": 1200 });
        expect(mapped.order).toBe(1200);
    });

    test("an unranked item keeps order null, which is not rank 0", () => {
        expect(mapSprintRow(3, {}).order).toBeNull();
    });

    test("fractional effort survives as a number", () => {
        expect(mapSprintRow(4, { "Microsoft.VSTS.Scheduling.CompletedWork": 5.75 }).completedWork).toBe(5.75);
    });
});

describe("sortByBacklogOrder", () => {
    test("ranked rows come first in ascending rank, unranked last by id", () => {
        const rows = [
            row({ id: 10010, type: "Incident" }),
            row({ id: 10004, type: "User Story", order: 1999999373 }),
            row({ id: 10001, type: "User Story", order: 1999962089 }),
            row({ id: 10006, type: "Incident" }),
            row({ id: 10008, type: "User Story", order: 1999981901 }),
            row({ id: 10009, type: "User Story" }),
            row({ id: 10003, type: "User Story", order: 1999986965 }),
            row({ id: 10002, type: "User Story", order: 1999985333 }),
        ];
        expect(sortByBacklogOrder(rows).map((r) => r.id)).toEqual([
            10001, 10008, 10002, 10003, 10004, 10006, 10009, 10010,
        ]);
    });

    test("equal ranks fall back to id so the order is stable", () => {
        const rows = [row({ id: 20, order: 5 }), row({ id: 10, order: 5 })];
        expect(sortByBacklogOrder(rows).map((r) => r.id)).toEqual([10, 20]);
    });

    test("does not mutate the input array", () => {
        const rows = [row({ id: 2, order: 2 }), row({ id: 1, order: 1 })];
        sortByBacklogOrder(rows);
        expect(rows.map((r) => r.id)).toEqual([2, 1]);
    });
});

describe("sortById", () => {
    test("sorts ascending by id", () => {
        expect(sortById([row({ id: 30 }), row({ id: 10 }), row({ id: 20 })]).map((r) => r.id)).toEqual([10, 20, 30]);
    });
});

describe("sumTaskEffort", () => {
    test("a User Story parent contributes nothing, only its child Task counts", () => {
        const rows = [
            row({ id: 1, type: "User Story", remainingWork: 40, completedWork: 10 }),
            row({ id: 2, type: "Task", remainingWork: 8, completedWork: 4 }),
        ];
        const totals = sumTaskEffort(rows);
        expect(totals.remainingWork).toBe(8);
        expect(totals.completedWork).toBe(4);
        expect(totals.taskCount).toBe(1);
        expect(totals.itemCount).toBe(2);
    });

    test("Feature, Bug and Incident rows are excluded from the Task sum", () => {
        const rows = [
            row({ id: 1, type: "Feature", remainingWork: 100 }),
            row({ id: 2, type: "Bug", remainingWork: 5 }),
            row({ id: 3, type: "Incident", remainingWork: 1 }),
            row({ id: 4, type: "Task", remainingWork: 8 }),
        ];
        expect(sumTaskEffort(rows).remainingWork).toBe(8);
    });

    test("fractional Task effort sums exactly", () => {
        const rows = [row({ id: 1, completedWork: 5.75 }), row({ id: 2, completedWork: 4.25 })];
        expect(sumTaskEffort(rows).completedWork).toBe(10);
    });

    test("an empty sprint totals to zero", () => {
        expect(sumTaskEffort([])).toEqual({ taskCount: 0, itemCount: 0, completedWork: 0, remainingWork: 0 });
    });
});
