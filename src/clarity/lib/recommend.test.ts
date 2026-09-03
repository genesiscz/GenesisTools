import { describe, expect, test } from "bun:test";
import { clarityTasksByAdoId, recommendClarityTask } from "@app/clarity/lib/recommend";
import type { ClarityTask } from "@app/clarity/lib/types";

function task(taskId: number, taskName: string): ClarityTask {
    return {
        taskId,
        taskName,
        taskCode: "00070705",
        investmentName: "Sample",
        investmentCode: "P100001",
        timeEntryId: 1,
    };
}

// Mirrors the real shapes: a leading id, a D_ prefixed id, and names carrying no id at all.
const TASKS: ClarityTask[] = [
    task(700001, "430001_Ceremonie - SU, planning_Sample_EXT"),
    task(700002, "D_410001_Sample epic_Sample_EXT"),
    task(700003, "D_420001_Sample programme_Sample_EXT"),
    task(700004, "Incidenty_Opex_Sample_EXT"),
    task(700005, "Rozvoj_domény_Sample_EXT"),
];

describe("clarityTasksByAdoId", () => {
    test("keys a task by the six-digit ADO id in its name, with or without the D_ prefix", () => {
        const byId = clarityTasksByAdoId(TASKS);

        expect([...byId.keys()].sort()).toEqual([410001, 420001, 430001]);
    });

    test("skips names that carry no ADO id", () => {
        const byId = clarityTasksByAdoId(TASKS);

        expect([...byId.values()].map((t) => t.taskId)).not.toContain(700004);
    });
});

describe("recommendClarityTask", () => {
    test("recommends the task whose id appears on the work item itself", () => {
        const result = recommendClarityTask({
            chain: [{ id: 430001, title: "Ceremonie", type: "Task" }],
            tasks: TASKS,
        });

        expect(result?.task.taskId).toBe(700001);
    });

    test("keeps climbing past ancestors that match nothing", () => {
        const result = recommendClarityTask({
            chain: [
                { id: 510001, title: "FE analýza", type: "Task" },
                { id: 520001, title: "Sample story", type: "User Story" },
                { id: 530001, title: "Sample feature", type: "Feature" },
                { id: 410001, title: "Sample epic", type: "Epic" },
            ],
            tasks: TASKS,
        });

        expect(result?.task.taskId).toBe(700002);
    });

    test("names the ancestor that matched, not the work item", () => {
        const result = recommendClarityTask({
            chain: [
                { id: 510001, title: "FE analýza", type: "Task" },
                { id: 410001, title: "Sample epic", type: "Epic" },
            ],
            tasks: TASKS,
        });

        expect(result?.matched).toEqual({ id: 410001, title: "Sample epic", type: "Epic" });
    });

    test("prefers the closest ancestor when two levels both match", () => {
        const result = recommendClarityTask({
            chain: [
                { id: 900001, title: "Leaf", type: "Task" },
                { id: 420001, title: "Sample programme", type: "Feature" },
                { id: 410001, title: "Sample epic", type: "Epic" },
            ],
            tasks: TASKS,
        });

        expect(result?.task.taskId).toBe(700003);
    });

    test("recommends nothing when no ancestor id matches a task name", () => {
        const result = recommendClarityTask({
            chain: [
                { id: 540001, title: "Sample bug", type: "Bug" },
                { id: 550001, title: "Sample suite", type: "Test Suite" },
            ],
            tasks: TASKS,
        });

        expect(result).toBeUndefined();
    });
});

describe("clarityTasksByAdoId edge cases", () => {
    test("does not read a seven-digit number as an ADO id", () => {
        const byId = clarityTasksByAdoId([task(700009, "D_1234567_Something_Sample_EXT")]);

        expect([...byId.keys()]).toEqual([]);
    });

    test("recommends neither task when two of them name the same work item", () => {
        const byId = clarityTasksByAdoId([
            task(700010, "D_410001_Technologický dluh_Sample_EXT"),
            task(700011, "D_410001_Technologický dluh duplicate_Sample_EXT"),
        ]);

        expect(byId.has(410001)).toBe(false);
    });
});

describe("clarityTasksByAdoId boundary", () => {
    test("does not read an investment code as an ADO id", () => {
        const byId = clarityTasksByAdoId([task(700012, "Rollup for investment P100001_Sample_EXT")]);

        expect([...byId.keys()]).toEqual([]);
    });
});
