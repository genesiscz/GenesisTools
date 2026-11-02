import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { type ClarityMapping, getConfig, saveConfig, storage } from "@app/clarity/config";
import type { AssignmentView } from "@app/clarity/lib/assignment-view";
import type { ClarityTask } from "@app/clarity/lib/types";
import { out } from "@genesiscz/utils/logger";

// Characterization of the two mapping doors: `clarity mappings --assign/--unlink` and the
// dashboard's addMapping, moveMapping and removeMapping. Both write the sandboxed config file.
// Azure DevOps and the assignment view are faked only while `active` is set, so other test files
// in this process keep the real modules.

let active = false;
let invalidations = 0;
let adoReachable = true;

function task(taskId: number, taskName: string): ClarityTask {
    return {
        taskId,
        taskName,
        taskCode: `C-${taskId}`,
        investmentName: `Investment ${taskId}`,
        investmentCode: `P-${taskId}`,
        timeEntryId: 1,
        totalActuals: 0,
    };
}

const TaskOne = task(700001, "Task One");
const TaskTwo = task(700002, "Task Two");

const View: AssignmentView = {
    month: 8,
    year: 2026,
    tasks: [TaskOne, TaskTwo],
    chains: new Map(),
    assigned: [{ workItemId: 510001, minutes: 120, title: "Row title one", type: "Task", drifted: false }],
    unassigned: [{ workItemId: 510004, minutes: 60, title: "Fresh work", type: "User Story", drifted: false }],
};

const realAssignmentView = { ...(await import("@app/clarity/lib/assignment-view")) };
const realAdoApi = { ...(await import("@app/azure-devops/api")) };
const realAdoUtils = { ...(await import("@app/azure-devops/utils")) };
const realServerAssignments = { ...(await import("@app/clarity/ui/src/server/assignments")) };

class UnreachableAdoApi {
    async getWorkItems(): Promise<never> {
        throw new Error("Azure DevOps is unreachable");
    }
}

mock.module("@app/clarity/lib/assignment-view", () => ({
    ...realAssignmentView,
    buildAssignmentView: async (date: string) => (active ? View : realAssignmentView.buildAssignmentView(date)),
}));
mock.module("@app/azure-devops/utils", () => ({
    ...realAdoUtils,
    requireConfig: (...args: Parameters<typeof realAdoUtils.requireConfig>) =>
        active ? { org: "https://dev.azure.com/sample-org", project: "Sample" } : realAdoUtils.requireConfig(...args),
}));
mock.module("@app/azure-devops/api", () => ({
    ...realAdoApi,
    Api: new Proxy(realAdoApi.Api, {
        construct(target, args) {
            if (active && !adoReachable) {
                return new UnreachableAdoApi();
            }

            return Reflect.construct(target, args);
        },
    }),
}));
mock.module("@app/clarity/ui/src/server/assignments", () => ({
    ...realServerAssignments,
    invalidateAssignmentView: () => {
        invalidations++;
        realServerAssignments.invalidateAssignmentView();
    },
}));

const { runMappings } = await import("@app/clarity/commands/mappings");
const { addMapping, moveMapping, removeMapping } = await import("@app/clarity/ui/src/server/mappings");

function stored(adoWorkItemId: number, task: ClarityTask, title: string, type?: string): ClarityMapping {
    return {
        clarityTaskId: task.taskId,
        clarityTaskName: task.taskName,
        clarityTaskCode: task.taskCode,
        clarityInvestmentName: task.investmentName,
        clarityInvestmentCode: task.investmentCode,
        adoWorkItemId,
        adoWorkItemTitle: title,
        adoWorkItemType: type,
    };
}

const Seed = [stored(510001, TaskOne, "Stored title one", "Bug"), stored(510002, TaskTwo, "Stored title two", "Task")];

async function seed(mappings: ClarityMapping[] = Seed): Promise<void> {
    await saveConfig({ baseUrl: "https://clarity.example.com", mappings });
}

async function mappingsOnDisk(): Promise<ClarityMapping[]> {
    return (await getConfig())?.mappings ?? [];
}

function brief(mapping: ClarityMapping): string {
    return `${mapping.adoWorkItemId}->${mapping.clarityTaskId} "${mapping.adoWorkItemTitle}" ${mapping.adoWorkItemType ?? "-"}`;
}

class ExitSignal extends Error {
    constructor(readonly code: number) {
        super(`process.exit(${code})`);
    }
}

async function runCli(
    options: Partial<Parameters<typeof runMappings>[0]>
): Promise<{ lines: string[]; exitCode?: number }> {
    const lines: string[] = [];
    const capture = (...parts: unknown[]) => {
        lines.push(Bun.stripANSI(parts.map(String).join(" ")));
    };
    const spies = [
        spyOn(out, "println").mockImplementation(capture),
        spyOn(out, "warn").mockImplementation(capture),
        spyOn(out, "error").mockImplementation(capture),
        spyOn(out, "result").mockImplementation(capture),
        spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
            throw new ExitSignal(typeof code === "number" ? code : 0);
        }),
    ];

    try {
        await runMappings({ format: "json", date: "2026-08", ...options });
        return { lines };
    } catch (err) {
        if (err instanceof ExitSignal) {
            return { lines, exitCode: err.code };
        }

        throw err;
    } finally {
        for (const spy of spies) {
            spy.mockRestore();
        }
    }
}

beforeAll(() => {
    if (storage.getConfigPath().startsWith(`${homedir()}/.genesis-tools`)) {
        throw new Error(
            `Refusing to run: the test sandbox is not installed, config path is ${storage.getConfigPath()}`
        );
    }
});

beforeEach(() => {
    active = true;
    adoReachable = true;
    invalidations = 0;
});

afterEach(() => {
    active = false;
    const path = storage.getConfigPath();

    if (existsSync(path)) {
        unlinkSync(path);
    }
});

describe("CLI clarity mappings", () => {
    test("--assign adds a mapping titled from the month's row", async () => {
        await seed();

        const run = await runCli({ assign: ["510004:700002"] });

        expect(run.exitCode).toBeUndefined();
        expect((await mappingsOnDisk()).map(brief)).toEqual([
            '510001->700001 "Stored title one" Bug',
            '510002->700002 "Stored title two" Task',
            '510004->700002 "Fresh work" User Story',
        ]);
        expect(invalidations).toBe(0);
    });

    test("--assign over an existing mapping needs --yes, then replaces it in place", async () => {
        await seed();

        const refused = await runCli({ assign: ["510001:700002"] });

        expect(refused.exitCode).toBe(1);
        expect((await mappingsOnDisk()).map(brief)).toEqual(Seed.map(brief));

        const run = await runCli({ assign: ["510001:700002"], yes: true });

        expect(run.exitCode).toBeUndefined();
        expect((await mappingsOnDisk()).map(brief)).toEqual([
            '510001->700002 "Row title one" Task',
            '510002->700002 "Stored title two" Task',
        ]);
    });

    test("with Azure DevOps unreachable an existing mapping keeps its title and a new one stores the id", async () => {
        await seed();
        adoReachable = false;

        const run = await runCli({ assign: ["510002:700001", "510009:700001"], yes: true });

        expect(run.exitCode).toBeUndefined();
        expect((await mappingsOnDisk()).map(brief)).toEqual([
            '510001->700001 "Stored title one" Bug',
            '510002->700001 "Stored title two" Task',
            '510009->700001 "510009" -',
        ]);
        expect(run.lines.some((line) => line.includes("could not read 2 work item title(s)"))).toBe(true);
    });

    test("--unlink removes the named mappings and leaves the file alone when none match", async () => {
        await seed();

        await runCli({ unlink: ["510001"], yes: true });

        expect((await mappingsOnDisk()).map(brief)).toEqual(['510002->700002 "Stored title two" Task']);

        const none = await runCli({ unlink: ["999999"], yes: true });

        expect(none.lines).toContain("No mappings match those work item ids.");
        expect((await mappingsOnDisk()).map(brief)).toEqual(['510002->700002 "Stored title two" Task']);
        expect(invalidations).toBe(0);
    });
});

function payload(adoWorkItemId: number, target: ClarityTask, title: unknown, type?: unknown): Record<string, unknown> {
    return {
        clarityTaskId: target.taskId,
        clarityTaskName: target.taskName,
        clarityTaskCode: target.taskCode,
        clarityInvestmentName: target.investmentName,
        clarityInvestmentCode: target.investmentCode,
        adoWorkItemId,
        adoWorkItemTitle: title,
        adoWorkItemType: type,
    };
}

function moveTarget(target: ClarityTask) {
    return {
        clarityTaskId: target.taskId,
        clarityTaskName: target.taskName,
        clarityTaskCode: target.taskCode,
        clarityInvestmentName: target.investmentName,
        clarityInvestmentCode: target.investmentCode,
    };
}

describe("dashboard mappings", () => {
    test("addMapping appends a new mapping and invalidates the assignment view", async () => {
        await seed();

        expect(await addMapping(payload(510004, TaskTwo, "Fresh work", "User Story"))).toEqual({ success: true });

        expect((await mappingsOnDisk()).map(brief)).toEqual([
            '510001->700001 "Stored title one" Bug',
            '510002->700002 "Stored title two" Task',
            '510004->700002 "Fresh work" User Story',
        ]);
        expect(invalidations).toBe(1);
    });

    test("addMapping over an existing work item replaces it in place", async () => {
        await seed();

        await addMapping(payload(510001, TaskTwo, "New title", "Task"));

        expect((await mappingsOnDisk()).map(brief)).toEqual([
            '510001->700002 "New title" Task',
            '510002->700002 "Stored title two" Task',
        ]);
    });

    test("addMapping with the titles the client sends when Azure DevOps is unreachable overwrites the stored ones", async () => {
        await seed();

        await addMapping(payload(510001, TaskTwo, "#510001", ""));
        await addMapping(payload(510002, TaskOne, "Work Item #510002"));

        expect((await mappingsOnDisk()).map(brief)).toEqual([
            '510001->700002 "#510001" ',
            '510002->700001 "Work Item #510002" -',
        ]);
    });

    test("addMapping rejects a malformed payload and writes nothing", async () => {
        await seed();

        await expect(addMapping({ ...payload(510004, TaskTwo, "Fresh work"), clarityTaskName: "" })).rejects.toThrow(
            "Invalid mapping payload: 'clarityTaskName' must be a non-empty string"
        );
        await expect(addMapping({ ...payload(510004, TaskTwo, "Fresh work"), adoWorkItemId: "x" })).rejects.toThrow(
            "Invalid mapping payload: 'adoWorkItemId' must be a number"
        );

        expect((await mappingsOnDisk()).map(brief)).toEqual(Seed.map(brief));
        expect(invalidations).toBe(0);
    });

    test("moveMapping repoints the task and keeps the title, type and position", async () => {
        await seed();

        expect(await moveMapping(510001, moveTarget(TaskTwo))).toEqual({ success: true });

        const [moved] = await mappingsOnDisk();
        expect(moved).toEqual({ ...stored(510001, TaskTwo, "Stored title one", "Bug") });
        expect(invalidations).toBe(1);

        await expect(moveMapping(999999, moveTarget(TaskOne))).rejects.toThrow(
            "Mapping for work item 999999 not found"
        );
        expect(invalidations).toBe(1);
    });

    test("removeMapping drops the work item, and saves and invalidates even when none matched", async () => {
        await seed();

        expect(await removeMapping(510001)).toEqual({ success: true });
        expect((await mappingsOnDisk()).map(brief)).toEqual(['510002->700002 "Stored title two" Task']);

        await removeMapping(999999);
        expect((await mappingsOnDisk()).map(brief)).toEqual(['510002->700002 "Stored title two" Task']);
        expect(invalidations).toBe(2);
    });

    test("every write refuses when Clarity is not configured", async () => {
        await expect(addMapping(payload(510004, TaskTwo, "Fresh work"))).rejects.toThrow("Clarity not configured");
        await expect(moveMapping(510001, moveTarget(TaskTwo))).rejects.toThrow("Clarity not configured");
        await expect(removeMapping(510001)).rejects.toThrow("Clarity not configured");
        expect(await getConfig()).toBeNull();
        expect(invalidations).toBe(0);
    });
});
