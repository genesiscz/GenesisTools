import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { WorkItemNode } from "@app/azure-devops/lib/ancestors";
import { getConfig, requireConfig, saveConfig, storage } from "@app/clarity/config";
import { applyAssignments, buildAssignmentRows, removeAssignments } from "@app/clarity/lib/assignments";
import type { ClarityTask } from "@app/clarity/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";

// The catalogue shape that matters: two tasks naming an ADO id, and two that name none, which is
// how a real Clarity month looks. Every id here is invented.
const TASKS: ClarityTask[] = (
    [
        ["D_410001_Sample epic_Sample_EXT", 700002],
        ["430001_Meetings_Sample_EXT", 700003],
        ["Incidents_Opex_Sample_EXT", 700004],
        ["Platform_roadmap_Sample_EXT", 700005],
    ] as Array<[string, number]>
).map(([taskName, taskId]) => ({
    taskId,
    taskName,
    taskCode: "00070705",
    investmentName: "Sample",
    investmentCode: "P100001",
    timeEntryId: 1,
    totalActuals: 0,
}));

// #510001 bills its epic 410001, #510002 names a task id directly, #510003 has no id anywhere in
// its chain and can only ever be mapped by hand.
const CHAINS = new Map<number, WorkItemNode[]>([
    [
        510001,
        [
            { id: 510001, title: "Sample task", type: "Task", parent: 410001 },
            { id: 410001, title: "Sample epic", type: "Epic" },
        ],
    ],
    [510002, [{ id: 430001, title: "Meetings", type: "Task" }]],
    [510003, [{ id: 510003, title: "Unmatched work", type: "Bug" }]],
]);

const MINUTES = new Map<number, number>([
    [510001, 600],
    [510002, 120],
    [510003, 300],
]);

const BASE_CONFIG = {
    baseUrl: "https://clarity.example.com",
    authToken: "test-token",
    sessionId: "test-session",
};

function fingerprint(mappings: Array<{ adoWorkItemId: number; clarityTaskId: number }>): string {
    return SafeJSON.stringify(
        [...mappings].sort((a, b) => a.adoWorkItemId - b.adoWorkItemId).map((m) => [m.adoWorkItemId, m.clarityTaskId])
    );
}

/** Rebuild every mapping the ancestor walk can prove, which is what `--apply-recommended` does. */
function recommendedPairs() {
    const { unassigned } = buildAssignmentRows({
        minutesByWorkItem: MINUTES,
        mappings: [],
        chains: CHAINS,
        tasks: TASKS,
    });

    return unassigned
        .filter((row) => row.recommendation)
        .map((row) => ({
            workItemId: row.workItemId,
            task: row.recommendation!.task,
            title: row.title,
            type: row.type,
        }));
}

describe("mapping round trip through the config file", () => {
    // preload-test-sandbox.ts bows out when GENESIS_TOOLS_HOME is already set, so a developer who
    // exports it at their real store gets no sandbox. This aborts rather than reports: a failing
    // assertion still lets the saveConfig tests below run against the live mapping table.
    beforeAll(() => {
        const path = storage.getConfigPath();

        if (path.startsWith(`${homedir()}/.genesis-tools`)) {
            throw new Error(`Refusing to run: the test sandbox is not installed, config path is ${path}`);
        }
    });

    test("writes to the test sandbox, never the user's own config", () => {
        expect(storage.getConfigPath().startsWith(`${homedir()}/.genesis-tools`)).toBe(false);
    });

    test("rebuilding removed mappings from the tree lands on identical mappings", async () => {
        await saveConfig({
            ...BASE_CONFIG,
            mappings: applyAssignments({ mappings: [], pairs: recommendedPairs() }),
        });

        const before = (await requireConfig()).mappings;
        expect(fingerprint(before)).toBe(
            SafeJSON.stringify([
                [510001, 700002],
                [510002, 700003],
            ])
        );
        const beforePrint = fingerprint(before);

        const stripped = removeAssignments({ mappings: before, workItemIds: [510001, 510002] });
        expect(stripped.removed).toHaveLength(2);
        await saveConfig({ ...BASE_CONFIG, mappings: stripped.mappings });
        expect((await requireConfig()).mappings).toEqual([]);

        await saveConfig({
            ...BASE_CONFIG,
            mappings: applyAssignments({ mappings: [], pairs: recommendedPairs() }),
        });

        expect(fingerprint((await requireConfig()).mappings)).toBe(beforePrint);
    });

    test("a work item whose chain names no task is never rebuilt, so no mapping is invented", () => {
        expect(
            recommendedPairs()
                .map((pair) => pair.workItemId)
                .sort()
        ).toEqual([510001, 510002]);
    });
});
describe("a config file that exists but fails the schema", () => {
    // getConfig returned null for it, and every caller read null as first-time setup: `configure auth`
    // and the UI's updateAuth then saved `mappings: []` over the user's mappings. Only a missing file
    // may read as first-time; a damaged one must throw, naming the path, and keep its bytes.
    const PLANTED = SafeJSON.stringify(
        {
            ...BASE_CONFIG,
            sessionId: 42,
            mappings: [
                {
                    clarityTaskId: 700002,
                    clarityTaskName: "Sample task",
                    clarityTaskCode: "00070705",
                    clarityInvestmentName: "Sample",
                    clarityInvestmentCode: "P100001",
                    adoWorkItemId: 510001,
                    adoWorkItemTitle: "Sample work item",
                },
            ],
        },
        null,
        2
    );

    afterEach(() => {
        const path = storage.getConfigPath();

        if (existsSync(path)) {
            unlinkSync(path);
        }
    });

    test("getConfig and requireConfig throw instead of reporting first-time setup", async () => {
        const path = storage.getConfigPath();
        await storage.ensureDirs();
        writeFileSync(path, PLANTED);

        await expect(getConfig()).rejects.toThrow(path);
        await expect(getConfig()).rejects.toThrow(/left untouched/);
        await expect(requireConfig()).rejects.toThrow(/sessionId/);
        expect(readFileSync(path, "utf8")).toBe(PLANTED);
    });

    test("a missing file is still first-time setup, and a save is 0600", async () => {
        expect(await getConfig()).toBeNull();

        await saveConfig({ ...BASE_CONFIG, mappings: [] });

        expect((await requireConfig()).baseUrl).toBe(BASE_CONFIG.baseUrl);

        if (process.platform !== "win32") {
            expect(statSync(storage.getConfigPath()).mode & 0o777).toBe(0o600);
        }
    });
});
