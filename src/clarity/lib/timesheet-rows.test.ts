import { describe, expect, test } from "bun:test";
import { addTaskRows, diffCatalogue, removeTaskRows } from "@app/clarity/lib/timesheet-rows";
import type { TimesheetResponse } from "@genesiscz/utils/clarity";

const ROW = {
    _internalId: 10311311,
    resourceId: 900001,
    taskId: 700042,
    taskCode: "00070705",
    taskName: "SampleTask_Release",
    investmentId: 300001,
    investmentName: "Sample Project",
    investmentCode: "P100001",
    totalActuals: 0,
};

function timesheetWith(rows: Array<Record<string, unknown>>): TimesheetResponse {
    return {
        timesheets: { _results: [{ _internalId: 555001, timeentries: { _results: rows } }] },
    } as unknown as TimesheetResponse;
}

function fakeApi(rows: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
    const created: Array<{ timesheetId: number; taskId: number }> = [];
    const deleted: Array<{ timesheetId: number; timeEntryId: number }> = [];

    return {
        created,
        deleted,
        getTimesheet: async () => timesheetWith(rows),
        createTimeEntry: async (timesheetId: number, taskId: number) => {
            created.push({ timesheetId, taskId });
        },
        deleteTimeEntry: async (timesheetId: number, timeEntryId: number) => {
            deleted.push({ timesheetId, timeEntryId });
        },
        ...overrides,
    };
}

describe("diffCatalogue", () => {
    test("splits the wanted tasks into the ones the week already carries and the ones it does not", () => {
        const result = diffCatalogue({
            have: [700042, 700043],
            want: [{ taskId: 700042 }, { taskId: 700099, taskName: "SampleTask_Ceremonies" }],
        });

        expect(result).toEqual({
            present: [{ taskId: 700042 }],
            missing: [{ taskId: 700099, taskName: "SampleTask_Ceremonies" }],
        });
    });

    test("asks for each task once even when the caller repeats it", () => {
        const result = diffCatalogue({ have: [], want: [{ taskId: 700099 }, { taskId: 700099 }] });

        expect(result.missing).toEqual([{ taskId: 700099 }]);
    });
});

describe("addTaskRows", () => {
    test("posts only the tasks the week is missing", async () => {
        const api = fakeApi([ROW]);

        const result = await addTaskRows({
            api,
            timesheetId: 555001,
            want: [{ taskId: 700042 }, { taskId: 700099, taskName: "SampleTask_Ceremonies" }],
        });

        expect(api.created).toEqual([{ timesheetId: 555001, taskId: 700099 }]);
        expect(result.added).toEqual([{ taskId: 700099, taskName: "SampleTask_Ceremonies" }]);
        expect(result.skipped).toEqual([{ taskId: 700042, taskName: "SampleTask_Release" }]);
        expect(result.failed).toEqual([]);
    });

    test("writes nothing when every wanted task is already there", async () => {
        const api = fakeApi([ROW]);

        await addTaskRows({ api, timesheetId: 555001, want: [{ taskId: 700042 }] });

        expect(api.created).toEqual([]);
    });

    test("records a failed post instead of throwing, so one bad task cannot lose the rest", async () => {
        const api = fakeApi([], {
            createTimeEntry: async (_timesheetId: number, taskId: number) => {
                if (taskId === 700099) {
                    throw new Error("API-1004 : invalid resource");
                }
            },
        });

        const result = await addTaskRows({
            api,
            timesheetId: 555001,
            want: [{ taskId: 700099 }, { taskId: 700100 }],
        });

        expect(result.added).toEqual([{ taskId: 700100 }]);
        expect(result.failed).toEqual([{ taskId: 700099, error: "API-1004 : invalid resource" }]);
    });

    test("names a missing task from the week's own catalogue when the caller supplied no name", async () => {
        const api = fakeApi([ROW]);

        const result = await addTaskRows({ api, timesheetId: 555001, want: [{ taskId: 700042 }] });

        expect(result.skipped[0].taskName).toBe("SampleTask_Release");
    });
});

describe("removeTaskRows", () => {
    test("deletes a row that carries no hours", async () => {
        const api = fakeApi([ROW]);

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700042] });

        expect(api.deleted).toEqual([{ timesheetId: 555001, timeEntryId: 10311311 }]);
        expect(result.removed).toEqual([{ taskId: 700042, taskName: "SampleTask_Release" }]);
    });

    // Deleting a row that carries actuals throws the reported hours away, and Clarity does not ask
    // for a confirmation of its own. Refuse rather than destroy a booked week.
    test("refuses a row that already carries hours", async () => {
        const api = fakeApi([{ ...ROW, totalActuals: 3600 }]);

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700042] });

        expect(api.deleted).toEqual([]);
        expect(result.blocked).toEqual([{ taskId: 700042, taskName: "SampleTask_Release", hours: 1 }]);
        expect(result.removed).toEqual([]);
    });

    // The API type says totalActuals is always a number, but the JSON is unchecked at runtime. A
    // guard that reads an absent value as zero deletes the very rows it exists to protect.
    test("refuses a row whose actuals the server did not report", async () => {
        const { totalActuals: _dropped, ...withoutActuals } = ROW;
        const api = fakeApi([withoutActuals]);

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700042] });

        expect(api.deleted).toEqual([]);
        expect(result.blocked).toEqual([{ taskId: 700042, taskName: "SampleTask_Release", hours: undefined }]);
        expect(result.removed).toEqual([]);
    });

    // JSON sends `null` for an absent number far more often than it omits the key, and both
    // `null > 0` and `NaN > 0` are false, so an `=== undefined` guard would let them through.
    test.each([
        ["null", null],
        ["NaN", Number.NaN],
    ])("refuses a row whose actuals came back as %s", async (_label, value) => {
        const api = fakeApi([{ ...ROW, totalActuals: value }]);

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700042] });

        expect(api.deleted).toEqual([]);
        expect(result.blocked).toEqual([{ taskId: 700042, taskName: "SampleTask_Release", hours: undefined }]);
    });

    // Regression: CodeRabbit on PR #353 — `> 0` reads a negative as empty. Clarity reports a
    // correction as negative actuals, and deleting that row loses the correction.
    test("refuses a row whose actuals are negative", async () => {
        const api = fakeApi([{ ...ROW, totalActuals: -3600 }]);

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700042] });

        expect(api.deleted).toEqual([]);
        expect(result.removed).toEqual([]);
    });

    test("reports a task the week never carried instead of failing", async () => {
        const api = fakeApi([ROW]);

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700099] });

        expect(result.missing).toEqual([700099]);
        expect(api.deleted).toEqual([]);
    });

    test("records a failed delete instead of throwing", async () => {
        const api = fakeApi([ROW], {
            deleteTimeEntry: async () => {
                throw new Error("API-1004 : invalid resource");
            },
        });

        const result = await removeTaskRows({ api, timesheetId: 555001, taskIds: [700042] });

        expect(result.failed).toEqual([
            { taskId: 700042, taskName: "SampleTask_Release", error: "API-1004 : invalid resource" },
        ]);
        expect(result.removed).toEqual([]);
    });
});

describe("addTaskRows reads the week it is about to write", () => {
    // Two weeks: 555001 already carries the task, 555002 does not. Reading the wrong one is the
    // failure that duplicates a row on a live timesheet, and the row count is the only tell.
    function twoWeekApi() {
        const created: Array<{ timesheetId: number; taskId: number }> = [];
        const rowsByTimesheet = new Map<number, Array<Record<string, unknown>>>([
            [555001, [ROW]],
            [555002, []],
        ]);

        return {
            created,
            getTimesheet: async (timesheetId: number) =>
                ({
                    timesheets: {
                        _results: [
                            {
                                _internalId: timesheetId,
                                timeentries: { _results: rowsByTimesheet.get(timesheetId) ?? [] },
                            },
                        ],
                    },
                }) as unknown as TimesheetResponse,
            createTimeEntry: async (timesheetId: number, taskId: number) => {
                created.push({ timesheetId, taskId });
            },
            deleteTimeEntry: async () => {},
        };
    }

    test("writes nothing to the week that already carries the task", async () => {
        const api = twoWeekApi();

        await addTaskRows({ api, timesheetId: 555001, want: [{ taskId: 700042 }] });

        expect(api.created).toEqual([]);
    });

    test("writes to the week that is missing the task", async () => {
        const api = twoWeekApi();

        await addTaskRows({ api, timesheetId: 555002, want: [{ taskId: 700042 }] });

        expect(api.created).toEqual([{ timesheetId: 555002, taskId: 700042 }]);
    });

    // `--add-from` pointing at the week it fills is the shape a copy loop gets wrong: the source
    // and the target are the same catalogue, so every task is already present.
    test("copying a week's catalogue onto itself writes nothing", async () => {
        const api = twoWeekApi();

        const result = await addTaskRows({ api, timesheetId: 555001, want: [{ taskId: 700042 }] });

        expect(api.created).toEqual([]);
        expect(result.skipped).toEqual([{ taskId: 700042, taskName: "SampleTask_Release" }]);
    });
});
