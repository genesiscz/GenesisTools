import { describe, expect, test } from "bun:test";
import type { WorkItemNode } from "@app/azure-devops/lib/ancestors";
import type { ClarityMapping } from "@app/clarity/config";
import {
    applyAssignments,
    buildAssignmentRows,
    recommendedPairsFor,
    removeAssignments,
} from "@app/clarity/lib/assignments";
import type { ClarityTask } from "@app/clarity/lib/types";

function task(taskId: number, taskName: string): ClarityTask {
    return {
        taskId,
        taskName,
        taskCode: "00070705",
        investmentName: "Sample",
        investmentCode: "P100001",
        timeEntryId: 1,
        totalActuals: 0,
    };
}

const TASKS: ClarityTask[] = [
    task(700002, "D_410001_Sample epic_Sample_EXT"),
    task(700004, "Incidenty_Opex_Sample_EXT"),
    task(700005, "Rozvoj_domény_Sample_EXT"),
];

const CHAINS = new Map<number, WorkItemNode[]>([
    [
        100001,
        [
            { id: 100001, title: "Tech debt task", type: "Task" },
            { id: 410001, title: "Sample epic", type: "Epic" },
        ],
    ],
    [100002, [{ id: 100002, title: "Bug with no match", type: "Bug" }]],
]);

function mapping(adoWorkItemId: number, clarityTaskId: number, clarityTaskName: string): ClarityMapping {
    return {
        clarityTaskId,
        clarityTaskName,
        clarityTaskCode: "00070705",
        clarityInvestmentName: "Sample",
        clarityInvestmentCode: "P100001",
        adoWorkItemId,
        adoWorkItemTitle: "Stored title",
        adoWorkItemType: "Task",
    };
}

describe("buildAssignmentRows", () => {
    test("splits work items by whether a mapping exists", () => {
        const { assigned, unassigned } = buildAssignmentRows({
            minutesByWorkItem: new Map([
                [100001, 240],
                [100002, 90],
            ]),
            mappings: [mapping(100001, 700005, "Rozvoj_domény_Sample_EXT")],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(assigned.map((r) => r.workItemId)).toEqual([100001]);
        expect(unassigned.map((r) => r.workItemId)).toEqual([100002]);
    });

    test("orders rows by hours, largest first", () => {
        const { unassigned } = buildAssignmentRows({
            minutesByWorkItem: new Map([
                [100002, 90],
                [100001, 240],
            ]),
            mappings: [],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(unassigned.map((r) => r.workItemId)).toEqual([100001, 100002]);
    });

    test("attaches the recommendation and the ancestor it matched", () => {
        const { unassigned } = buildAssignmentRows({
            minutesByWorkItem: new Map([[100001, 240]]),
            mappings: [],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(unassigned[0].recommendation?.task.taskId).toBe(700002);
        expect(unassigned[0].recommendation?.matched.id).toBe(410001);
    });

    test("leaves the recommendation empty when no ancestor id matches", () => {
        const { unassigned } = buildAssignmentRows({
            minutesByWorkItem: new Map([[100002, 90]]),
            mappings: [],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(unassigned[0].recommendation).toBeUndefined();
    });

    test("flags an assigned row whose stored task differs from the recommendation", () => {
        const { assigned } = buildAssignmentRows({
            minutesByWorkItem: new Map([[100001, 240]]),
            mappings: [mapping(100001, 700005, "Rozvoj_domény_Sample_EXT")],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(assigned[0].drifted).toBe(true);
    });

    test("does not flag an assigned row that already matches its recommendation", () => {
        const { assigned } = buildAssignmentRows({
            minutesByWorkItem: new Map([[100001, 240]]),
            mappings: [mapping(100001, 700002, "D_410001_Sample epic_Sample_EXT")],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(assigned[0].drifted).toBe(false);
    });
});

describe("applyAssignments", () => {
    test("adds a mapping for a work item that had none", () => {
        const next = applyAssignments({
            mappings: [],
            pairs: [{ workItemId: 100001, task: TASKS[0], title: "Tech debt task", type: "Task" }],
        });

        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({
            adoWorkItemId: 100001,
            clarityTaskId: 700002,
            adoWorkItemTitle: "Tech debt task",
        });
    });

    test("replaces the existing mapping instead of adding a duplicate", () => {
        const next = applyAssignments({
            mappings: [mapping(100001, 700005, "Rozvoj_domény_Sample_EXT")],
            pairs: [{ workItemId: 100001, task: TASKS[0], title: "Tech debt task", type: "Task" }],
        });

        expect(next).toHaveLength(1);
        expect(next[0].clarityTaskId).toBe(700002);
    });

    test("leaves mappings for other work items untouched", () => {
        const next = applyAssignments({
            mappings: [mapping(999999, 700004, "Incidenty_Opex_Sample_EXT")],
            pairs: [{ workItemId: 100001, task: TASKS[0], title: "Tech debt task", type: "Task" }],
        });

        expect(next.map((m) => m.adoWorkItemId).sort()).toEqual([100001, 999999]);
    });
});

describe("removeAssignments", () => {
    test("drops only the named work items and reports what went", () => {
        const { mappings, removed } = removeAssignments({
            mappings: [mapping(100001, 700002, "A"), mapping(100002, 700004, "B")],
            workItemIds: [100002],
        });

        expect(mappings.map((m) => m.adoWorkItemId)).toEqual([100001]);
        expect(removed.map((m) => m.adoWorkItemId)).toEqual([100002]);
    });

    test("reports nothing removed when no work item matches", () => {
        const { mappings, removed } = removeAssignments({
            mappings: [mapping(100001, 700002, "A")],
            workItemIds: [555555],
        });

        expect(removed).toEqual([]);
        expect(mappings).toHaveLength(1);
    });
});

describe("recommendedPairsFor", () => {
    // The safety property behind `--apply-recommended`: it creates mappings, it never repoints one
    // the operator made by hand. A drifted row is reported, not corrected.
    test("skips a work item that is already mapped, even when the tree disputes the mapping", () => {
        const rows = buildAssignmentRows({
            minutesByWorkItem: new Map([[100001, 600]]),
            mappings: [mapping(100001, 700004, "Incidenty_Opex_Sample_EXT")],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(rows.assigned[0].drifted).toBe(true);
        expect(recommendedPairsFor(rows)).toEqual([]);
    });

    test("pairs an unmapped work item with the task its ancestor names", () => {
        const rows = buildAssignmentRows({
            minutesByWorkItem: new Map([[100001, 600]]),
            mappings: [],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(recommendedPairsFor(rows)).toEqual([
            { workItemId: 100001, task: TASKS[0], title: "Tech debt task", type: "Task" },
        ]);
    });

    test("skips an unmapped work item whose chain names no task", () => {
        const rows = buildAssignmentRows({
            minutesByWorkItem: new Map([[100002, 300]]),
            mappings: [],
            chains: CHAINS,
            tasks: TASKS,
        });

        expect(recommendedPairsFor(rows)).toEqual([]);
    });
});

describe("applyAssignments with repeated pairs", () => {
    // A duplicate entry would not be visible in the output, but getMappingForWorkItem returns the
    // FIRST match, so the stale one would win and the user's later choice would be lost.
    test("leaves one mapping when the same work item is assigned twice in one call", () => {
        const result = applyAssignments({
            mappings: [],
            pairs: [
                { workItemId: 100001, task: TASKS[1] },
                { workItemId: 100001, task: TASKS[2] },
            ],
        });

        expect(result).toHaveLength(1);
        expect(result[0].clarityTaskId).toBe(700005);
    });
});

describe("removeAssignments matches the work item, not the Clarity task", () => {
    // `--unlink 700004` is a plausible slip: 700004 is a Clarity task id, and every mapping that
    // bills it would go at once if the filter matched either id.
    test("removes nothing when the id names a Clarity task rather than a work item", () => {
        const mappings = [mapping(100001, 700004, "Incidenty_Opex_Sample_EXT")];

        const result = removeAssignments({ mappings, workItemIds: [700004] });

        expect(result.removed).toEqual([]);
        expect(result.mappings).toEqual(mappings);
    });
});
