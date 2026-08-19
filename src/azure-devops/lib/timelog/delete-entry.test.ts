import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffortApi } from "@app/azure-devops/timelog-effort";
import { appendEffortJournal, readEffortJournal } from "@app/azure-devops/timelog-effort-journal";
import type { JsonPatchOperation, TimeLogEntry, TimeLogQueryEntry, TimeLogUser } from "@app/azure-devops/types";
import { env } from "@genesiscz/utils/env";
import { type DeleteTimeLogOptions, deleteTimeLogEntryWithEffort, type TimeLogDeleteApi } from "./delete-entry";

const snapshot = env.testing.snapshot();
const root = mkdtempSync(join(tmpdir(), "timelog-delete-"));

afterAll(() => {
    env.testing.restore(snapshot);
    rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    env.testing.set("GENESIS_TOOLS_HOME", root);
});

const user: TimeLogUser = {
    userId: "user-1",
    userName: "Martin",
    userEmail: "m@example.com",
};

function queryEntry(overrides: Partial<TimeLogQueryEntry> = {}): TimeLogQueryEntry {
    return {
        timeLogId: "log-1",
        comment: null,
        week: "2026-W34",
        timeTypeId: "type-1",
        timeTypeDescription: "Development",
        minutes: 120,
        date: "2026-08-19T00:00:00",
        userId: user.userId,
        userName: user.userName,
        userEmail: user.userEmail,
        projectId: "proj-1",
        workItemId: 296936,
        createdOn: "2026-08-19T13:00:00Z",
        createdBy: user.userId,
        updatedOn: null,
        updatedBy: null,
        deletedOn: null,
        deletedBy: null,
        ...overrides,
    };
}

function workItemEntry(overrides: Partial<TimeLogEntry> = {}): TimeLogEntry {
    return {
        timeLogId: "log-1",
        comment: "",
        week: "2026-W34",
        timeTypeDescription: "Development",
        minutes: 120,
        date: "2026-08-19",
        userId: user.userId,
        userName: user.userName,
        userEmail: user.userEmail,
        ...overrides,
    };
}

function makeApis(args: {
    remaining: number | null;
    completed: number | null;
    entries?: TimeLogEntry[];
    query?: TimeLogQueryEntry[];
    queries?: TimeLogQueryEntry[][];
    queryError?: Error;
    updateError?: Error;
    deleteError?: Error;
}): {
    devops: EffortApi;
    timelog: TimeLogDeleteApi;
    calls: string[];
    patches: JsonPatchOperation[][];
} {
    const calls: string[] = [];
    const patches: JsonPatchOperation[][] = [];
    let remaining = args.remaining;
    let completed = args.completed;
    let queryCall = 0;

    const devops: EffortApi = {
        async getWorkItem() {
            calls.push("get");
            return {
                rawFields: {
                    "Microsoft.VSTS.Scheduling.RemainingWork": remaining,
                    "Microsoft.VSTS.Scheduling.CompletedWork": completed,
                },
            };
        },
        async updateWorkItem(_id, operations) {
            calls.push("update");
            patches.push(operations);

            if (args.updateError) {
                throw args.updateError;
            }

            for (const op of operations) {
                if (op.path.endsWith("RemainingWork")) {
                    remaining = op.value as number;
                }

                if (op.path.endsWith("CompletedWork")) {
                    completed = op.value as number;
                }
            }

            return {};
        },
    };

    const timelog: TimeLogDeleteApi = {
        async deleteTimeLogEntry() {
            calls.push("delete");

            if (args.deleteError) {
                throw args.deleteError;
            }
        },
        async getWorkItemTimeLogs() {
            calls.push("wi-logs");
            return args.entries ?? [workItemEntry()];
        },
        async queryTimeLogs() {
            calls.push("query");

            if (args.queryError) {
                throw args.queryError;
            }

            if (args.queries) {
                const page = args.queries[Math.min(queryCall, args.queries.length - 1)] ?? [];
                queryCall += 1;
                return page;
            }

            return args.query ?? [queryEntry()];
        },
    };

    return { devops, timelog, calls, patches };
}

function baseOpts(apis: ReturnType<typeof makeApis>, extra: Partial<DeleteTimeLogOptions> = {}): DeleteTimeLogOptions {
    return {
        timeLogApi: apis.timelog,
        devopsApi: apis.devops,
        timeLogId: "log-1",
        user,
        projectId: "proj-1",
        journalPath: join(root, `case-${crypto.randomUUID()}.jsonl`),
        confirm: async () => true,
        ...extra,
    };
}

describe("deleteTimeLogEntryWithEffort", () => {
    test("exact journal restore: get → delete → write remainingBefore/completedBefore", async () => {
        const journalPath = join(root, "exact.jsonl");
        await appendEffortJournal(
            {
                ts: "2026-08-19T13:03:11.482Z",
                workItemId: 296936,
                timeLogIds: ["log-1"],
                minutes: 120,
                remainingBefore: 10,
                completedBefore: 4,
                remainingAfter: 8,
                completedAfter: 6,
            },
            journalPath
        );
        const apis = makeApis({ remaining: 8, completed: 6 });
        const result = await deleteTimeLogEntryWithEffort(
            baseOpts(apis, { workItemId: 296936, knownMinutes: 120, journalPath })
        );

        expect(result.status).toBe("deleted");
        const ordered = apis.calls.filter((c) => c === "get" || c === "delete" || c === "update");
        expect(ordered[0]).toBe("get");
        expect(ordered.indexOf("delete")).toBeLessThan(ordered.indexOf("update"));
        expect(apis.patches[0].map((op) => op.value)).toEqual([10, 4]);

        if (result.status === "deleted") {
            expect(result.plan?.reason).toBe("exact-journal");
            expect(result.effort).toMatchObject({ remaining: 10, completed: 4 });
        }
    });

    test("clamped add restores 3/0, not 8/0", async () => {
        const journalPath = join(root, "clamp.jsonl");
        await appendEffortJournal(
            {
                ts: "2026-08-19T13:03:11.482Z",
                workItemId: 303818,
                timeLogIds: ["log-1"],
                minutes: 480,
                remainingBefore: 3,
                completedBefore: 0,
                remainingAfter: 0,
                completedAfter: 8,
            },
            journalPath
        );
        const apis = makeApis({ remaining: 0, completed: 8 });
        const result = await deleteTimeLogEntryWithEffort(
            baseOpts(apis, { workItemId: 303818, knownMinutes: 480, journalPath })
        );

        expect(apis.patches[0].map((op) => op.value)).toEqual([3, 0]);

        if (result.status === "deleted") {
            expect(result.plan?.reason).toBe("exact-journal");
        }
    });

    test("no journal: arithmetic fallback plus warning", async () => {
        const journalPath = join(root, "no-journal.jsonl");
        const apis = makeApis({ remaining: 0, completed: 38 });
        const result = await deleteTimeLogEntryWithEffort(
            baseOpts(apis, { workItemId: 296936, knownMinutes: 480, journalPath })
        );

        expect(apis.patches[0].map((op) => op.value)).toEqual([8, 30]);

        if (result.status === "deleted") {
            expect(result.plan?.reason).toBe("approximate-no-journal");
            expect(result.plan?.warning).toContain("approximate");
        }
    });

    test("import batch: deleting one id subtracts only that entry", async () => {
        const journalPath = join(root, "batch.jsonl");
        await appendEffortJournal(
            {
                ts: "2026-08-19T13:03:11.482Z",
                workItemId: 1,
                timeLogIds: ["log-1", "log-2", "log-3", "log-4", "log-5"],
                minutes: 300,
                remainingBefore: 10,
                completedBefore: 0,
                remainingAfter: 5,
                completedAfter: 5,
            },
            journalPath
        );
        const apis = makeApis({ remaining: 5, completed: 5 });
        const result = await deleteTimeLogEntryWithEffort(
            baseOpts(apis, { workItemId: 1, knownMinutes: 60, journalPath })
        );

        expect(apis.patches[0].map((op) => op.value)).toEqual([6, 4]);

        if (result.status === "deleted") {
            expect(result.plan?.reason).toBe("approximate-multi-id");
        }
    });

    test("--no-effort deletes the row and never reads or writes effort", async () => {
        const apis = makeApis({ remaining: 8, completed: 6 });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis, { noEffort: true }));
        expect(result.status).toBe("deleted");
        expect(apis.calls).toEqual(["delete"]);
    });

    test("--dry-run writes nothing at all", async () => {
        const apis = makeApis({ remaining: 8, completed: 6 });
        const result = await deleteTimeLogEntryWithEffort(
            baseOpts(apis, { dryRun: true, workItemId: 296936, knownMinutes: 120 })
        );
        expect(result.status).toBe("dry-run");
        expect(apis.calls).toEqual(["get"]);
        expect(apis.patches).toHaveLength(0);
    });

    test("locked work item still deletes the row and only warns", async () => {
        const apis = makeApis({
            remaining: 8,
            completed: 6,
            updateError: new Error("TF401320: InvalidNotEmpty"),
        });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis, { workItemId: 297506, knownMinutes: 120 }));
        expect(result.status).toBe("deleted");
        expect(apis.calls).toContain("delete");

        if (result.status === "deleted") {
            expect(result.effort).toBeNull();
        }
    });

    test("confirm false cancels before delete", async () => {
        const apis = makeApis({ remaining: 8, completed: 6 });
        const result = await deleteTimeLogEntryWithEffort(
            baseOpts(apis, { workItemId: 1, knownMinutes: 60, confirm: async () => false })
        );
        expect(result.status).toBe("cancelled");
        expect(apis.calls).toEqual(["get"]);
    });

    test("resolves a bare id via queryTimeLogs", async () => {
        const journalPath = join(root, "query.jsonl");
        const apis = makeApis({ remaining: 8, completed: 6, query: [queryEntry()] });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis, { journalPath }));
        expect(result.status).toBe("deleted");
        expect(apis.calls).toContain("query");

        if (result.status === "deleted") {
            expect(result.resolved).toEqual({ workItemId: 296936, minutes: 120, source: "query" });
        }
    });

    test("unresolved id refuses to delete unless --no-effort", async () => {
        const journalPath = join(root, "unresolved.jsonl");
        const apis = makeApis({ remaining: 8, completed: 6, entries: [], query: [] });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis, { journalPath }));
        expect(result.status).toBe("needs-resolution");
        expect(apis.calls).not.toContain("delete");
        expect(apis.calls).not.toContain("update");
    });

    test("single-id journal fallback uses journal minutes when the live row is gone", async () => {
        const journalPath = join(root, "journal-fallback.jsonl");
        await appendEffortJournal(
            {
                ts: "2026-08-19T13:03:11.482Z",
                workItemId: 303818,
                timeLogIds: ["log-1"],
                minutes: 90,
                remainingBefore: 5,
                completedBefore: 1,
                remainingAfter: 3.5,
                completedAfter: 2.5,
            },
            journalPath
        );
        const apis = makeApis({ remaining: 3.5, completed: 2.5, entries: [], query: [] });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis, { journalPath }));
        expect(result.status).toBe("deleted");
        expect(apis.calls.filter((c) => c === "query")).toHaveLength(0);

        if (result.status === "deleted") {
            expect(result.resolved).toEqual({ workItemId: 303818, minutes: 90, source: "journal" });
            expect(result.plan?.reason).toBe("exact-journal");
            expect(apis.patches[0].map((op) => op.value)).toEqual([5, 1]);
        }
    });

    test("falls back to the unscoped project query when the user query misses", async () => {
        const journalPath = join(root, "unscoped.jsonl");
        const apis = makeApis({
            remaining: 8,
            completed: 6,
            entries: [],
            queries: [[], [queryEntry()]],
        });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis, { journalPath }));
        expect(result.status).toBe("deleted");
        expect(apis.calls.filter((c) => c === "query")).toHaveLength(2);

        if (result.status === "deleted") {
            expect(result.resolved).toEqual({ workItemId: 296936, minutes: 120, source: "query" });
        }
    });

    test("a thrown resolve does not delete the row", async () => {
        const apis = makeApis({
            remaining: 8,
            completed: 6,
            entries: [],
            queryError: new Error("TimeLog API Error 500: boom"),
        });
        const result = await deleteTimeLogEntryWithEffort(baseOpts(apis));
        expect(result.status).toBe("needs-resolution");
        expect(apis.calls).not.toContain("delete");
        expect(apis.calls).not.toContain("update");
    });

    test("rollback does not append a new journal row", async () => {
        const journalPath = join(root, "no-rollback-journal.jsonl");
        await appendEffortJournal(
            {
                ts: "2026-08-19T13:03:11.482Z",
                workItemId: 296936,
                timeLogIds: ["log-1"],
                minutes: 120,
                remainingBefore: 10,
                completedBefore: 4,
                remainingAfter: 8,
                completedAfter: 6,
            },
            journalPath
        );
        const apis = makeApis({ remaining: 8, completed: 6 });
        await deleteTimeLogEntryWithEffort(baseOpts(apis, { workItemId: 296936, knownMinutes: 120, journalPath }));
        const records = readEffortJournal(journalPath);
        expect(records).toHaveLength(1);
        expect(records[0].minutes).toBe(120);
    });
});
