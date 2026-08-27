import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonPatchOperation } from "@app/azure-devops/types";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { computeEffortValues, type EffortApi, updateWorkItemEffort } from "./timelog-effort";
import { type EffortJournalRecord, effortJournalPath, readEffortJournal } from "./timelog-effort-journal";

const snapshot = env.testing.snapshot();
const root = mkdtempSync(join(tmpdir(), "timelog-effort-"));

afterAll(() => {
    env.testing.restore(snapshot);
    rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", root);
});

function mockApi(fields: Record<string, unknown> | undefined): EffortApi & {
    updates: JsonPatchOperation[][];
    getCalls: number;
} {
    const updates: JsonPatchOperation[][] = [];
    let remaining = fields?.["Microsoft.VSTS.Scheduling.RemainingWork"];
    let completed = fields?.["Microsoft.VSTS.Scheduling.CompletedWork"];
    const hasFields = fields !== undefined;
    let getCalls = 0;

    return {
        getCalls,
        updates,
        async getWorkItem() {
            getCalls += 1;
            this.getCalls = getCalls;

            if (!hasFields) {
                return { rawFields: undefined };
            }

            return {
                rawFields: {
                    "Microsoft.VSTS.Scheduling.RemainingWork": remaining,
                    "Microsoft.VSTS.Scheduling.CompletedWork": completed,
                },
            };
        },
        async updateWorkItem(_id: number, operations: JsonPatchOperation[]) {
            updates.push(operations);

            for (const op of operations) {
                if (op.path.endsWith("RemainingWork")) {
                    remaining = op.value;
                }

                if (op.path.endsWith("CompletedWork")) {
                    completed = op.value;
                }
            }

            return {};
        },
    };
}

describe("computeEffortValues", () => {
    test("add 2h on Remaining 10 / Completed 4 → 8 and 6", () => {
        expect(computeEffortValues(10, 4, 120)).toEqual({ remaining: 8, completed: 6 });
    });

    test("add 8h on Remaining 3 clamps Remaining at 0", () => {
        expect(computeEffortValues(3, 0, 480)).toEqual({ remaining: 0, completed: 8 });
    });

    test("negative minutes undo an add and clamp Completed at 0", () => {
        expect(computeEffortValues(0, 6.5, -390)).toEqual({ remaining: 6.5, completed: 0 });
        expect(computeEffortValues(8, 2, -480)).toEqual({ remaining: 16, completed: 0 });
    });

    test("null fields behave as 0", () => {
        expect(computeEffortValues(null, undefined, 120)).toEqual({ remaining: 0, completed: 2 });
    });
});

describe("updateWorkItemEffort", () => {
    test("writes Remaining/Completed and journals the before/after pair", async () => {
        const api = mockApi({
            "Microsoft.VSTS.Scheduling.RemainingWork": 10,
            "Microsoft.VSTS.Scheduling.CompletedWork": 4,
        });
        const journalPath = join(root, "case-add.jsonl");
        const result = await updateWorkItemEffort(api, 10007, 120, {
            timeLogIds: ["abc-1"],
            journalPath,
        });

        expect(result).toEqual({
            remaining: 8,
            completed: 6,
            remainingBefore: 10,
            completedBefore: 4,
        });
        expect(api.updates).toHaveLength(1);
        expect(api.updates[0].map((op) => op.value)).toEqual([8, 6]);

        const records = readEffortJournal(journalPath);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            workItemId: 10007,
            timeLogIds: ["abc-1"],
            minutes: 120,
            remainingBefore: 10,
            completedBefore: 4,
            remainingAfter: 8,
            completedAfter: 6,
        } satisfies Partial<EffortJournalRecord>);
        expect(records[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("journals to the default path under GENESIS_TOOLS_HOME", async () => {
        const api = mockApi({
            "Microsoft.VSTS.Scheduling.RemainingWork": 1,
            "Microsoft.VSTS.Scheduling.CompletedWork": 0,
        });
        await updateWorkItemEffort(api, 1, 60, { timeLogIds: ["home-1"] });
        const records = readEffortJournal(effortJournalPath());
        expect(records.some((r) => r.timeLogIds.includes("home-1"))).toBe(true);
    });

    test("journal:false skips the journal file", async () => {
        const api = mockApi({
            "Microsoft.VSTS.Scheduling.RemainingWork": 5,
            "Microsoft.VSTS.Scheduling.CompletedWork": 1,
        });
        const journalPath = join(root, "case-nojournal.jsonl");
        await updateWorkItemEffort(api, 1, 60, { journal: false, journalPath, timeLogIds: ["x"] });
        expect(readEffortJournal(journalPath)).toEqual([]);
    });

    test("values: writes the exact pair instead of signed math", async () => {
        const api = mockApi({
            "Microsoft.VSTS.Scheduling.RemainingWork": 0,
            "Microsoft.VSTS.Scheduling.CompletedWork": 8,
        });
        const result = await updateWorkItemEffort(api, 10012, -480, {
            journal: false,
            values: { remaining: 3, completed: 0 },
        });
        expect(result?.remaining).toBe(3);
        expect(result?.completed).toBe(0);
        expect(api.updates[0].map((op) => op.value)).toEqual([3, 0]);
    });

    test("adds fields that were missing", async () => {
        const api = mockApi({});
        await updateWorkItemEffort(api, 1, 60, { journal: false });
        expect(api.updates[0].map((op) => op.op)).toEqual(["add", "add"]);
    });

    test("skips when rawFields is missing", async () => {
        const api = mockApi(undefined);
        const result = await updateWorkItemEffort(api, 1, 60, { journal: false });
        expect(result).toBeNull();
        expect(api.updates).toHaveLength(0);
    });

    test("update failure is non-fatal and does not journal", async () => {
        const api = mockApi({
            "Microsoft.VSTS.Scheduling.RemainingWork": 2,
            "Microsoft.VSTS.Scheduling.CompletedWork": 0,
        });
        api.updateWorkItem = async () => {
            throw new Error("TF401320: InvalidNotEmpty");
        };
        const journalPath = join(root, "case-locked.jsonl");
        const result = await updateWorkItemEffort(api, 10011, 60, { journalPath, timeLogIds: ["locked"] });
        expect(result).toBeNull();
        expect(readEffortJournal(journalPath)).toEqual([]);
    });
});

describe("effort journal parse", () => {
    test("skips malformed lines and returns the newest match", async () => {
        const path = join(root, "parse.jsonl");
        const older = {
            ts: "2026-08-01T00:00:00.000Z",
            workItemId: 1,
            timeLogIds: ["same"],
            minutes: 60,
            remainingBefore: 10,
            completedBefore: 0,
            remainingAfter: 9,
            completedAfter: 1,
        };
        const newer = { ...older, ts: "2026-08-19T00:00:00.000Z", remainingAfter: 8, completedAfter: 2 };
        const { appendFileSync } = await import("node:fs");
        appendFileSync(path, "not-json\n");
        appendFileSync(path, `${SafeJSON.stringify(older, { strict: true })}\n`);
        appendFileSync(path, `${SafeJSON.stringify({ ts: "x" }, { strict: true })}\n`);
        appendFileSync(path, `${SafeJSON.stringify(newer, { strict: true })}\n`);

        const { findNewestEffortJournal } = await import("./timelog-effort-journal");
        const hit = findNewestEffortJournal("same", path);
        expect(hit?.remainingAfter).toBe(8);
        expect(readEffortJournal(path)).toHaveLength(2);
    });
});
