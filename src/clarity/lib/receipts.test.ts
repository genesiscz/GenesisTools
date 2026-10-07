import { describe, expect, test } from "bun:test";
import type { ClarityMapping } from "@app/clarity/config";
import { assignReceipt, rowWriteReceipt, unlinkReceipt } from "@app/clarity/lib/receipts";

function mapping(adoWorkItemId: number, clarityTaskId: number, clarityTaskName: string): ClarityMapping {
    return {
        clarityTaskId,
        clarityTaskName,
        clarityTaskCode: "00070705",
        clarityInvestmentName: "Sample",
        clarityInvestmentCode: "P100001",
        adoWorkItemId,
        adoWorkItemTitle: "Sample work item",
        adoWorkItemType: "Task",
    };
}

describe("unlinkReceipt", () => {
    // The undo has to name the TASK each work item billed. A hint that only says "re-map them"
    // sends the operator back to a catalogue lookup they already did once.
    test("undoes an unlink by re-assigning each work item to the task it billed", () => {
        const receipt = unlinkReceipt([
            mapping(123456, 7000001, "456789_Operations"),
            mapping(234567, 7000002, "D_567890_Technical debt"),
        ]);

        expect(receipt.undo).toEqual(["mappings", "--assign", "123456:7000001", "234567:7000002"]);
    });

    test("counts what was removed", () => {
        const receipt = unlinkReceipt([mapping(123456, 7000001, "456789_Operations")]);

        expect(receipt.summary).toEqual(["1 mapping removed"]);
    });

    test("pluralises the count", () => {
        const receipt = unlinkReceipt([
            mapping(123456, 7000001, "456789_Operations"),
            mapping(234567, 7000002, "D_567890_Technical debt"),
        ]);

        expect(receipt.summary).toEqual(["2 mappings removed"]);
    });

    test("offers no undo when nothing was removed", () => {
        expect(unlinkReceipt([])).toEqual({ summary: [] });
    });
});

describe("assignReceipt", () => {
    // Re-assigning a work item to the task it already has only refreshes the stored title. Calling it
    // "created" offered `--unlink` as the undo, which would delete a mapping that predates the run.
    test("reports a same-task re-assign as refreshed, with nothing to undo", () => {
        const receipt = assignReceipt({
            created: [],
            replaced: [],
            refreshed: [{ workItemId: 345678, clarityTaskId: 7000002 }],
        });

        expect(receipt).toEqual({ summary: ["1 mapping refreshed"] });
    });

    test("counts created and replaced mappings apart", () => {
        const receipt = assignReceipt({
            created: [{ workItemId: 123456, clarityTaskId: 7000001 }],
            replaced: [{ workItemId: 234567, clarityTaskId: 7000002, previousClarityTaskId: 7000003 }],
        });

        expect(receipt.summary).toEqual(["1 mapping created", "1 mapping replaced"]);
    });

    // A created mapping is undone by removing it; a replaced one is undone by putting the previous
    // task back. Unlinking a replaced work item would throw away a mapping that predates the run.
    test("undoes a created mapping by unlinking it and a replaced one by restoring its old task", () => {
        const receipt = assignReceipt({
            created: [{ workItemId: 123456, clarityTaskId: 7000001 }],
            replaced: [{ workItemId: 234567, clarityTaskId: 7000002, previousClarityTaskId: 7000003 }],
        });

        expect(receipt.undo).toEqual(["mappings", "--assign", "234567:7000003", "--unlink", "123456"]);
    });

    test("omits the unlink half when nothing was created", () => {
        const receipt = assignReceipt({
            created: [],
            replaced: [{ workItemId: 234567, clarityTaskId: 7000002, previousClarityTaskId: 7000003 }],
        });

        expect(receipt.undo).toEqual(["mappings", "--assign", "234567:7000003"]);
    });

    test("omits the assign half when nothing was replaced", () => {
        const receipt = assignReceipt({ created: [{ workItemId: 123456, clarityTaskId: 7000001 }], replaced: [] });

        expect(receipt.undo).toEqual(["mappings", "--unlink", "123456"]);
    });

    test("offers no undo when nothing changed", () => {
        expect(assignReceipt({ created: [], replaced: [] })).toEqual({ summary: [] });
    });
});

describe("rowWriteReceipt", () => {
    const ADDED_TWO_WEEKS = [
        { timesheetId: 7100092, added: [{ taskId: 7000005 }, { taskId: 7000008 }], skipped: [], failed: [] },
        { timesheetId: 7100089, added: [{ taskId: 7000005 }], skipped: [{ taskId: 7000008 }], failed: [] },
        { unopened: true },
    ];

    test("counts rows across every week, and the weeks Clarity has not opened", () => {
        const receipt = rowWriteReceipt({ outcomes: ADDED_TWO_WEEKS, date: "2026-09" });

        expect(receipt.summary).toEqual(["3 rows added", "1 row already there", "1 week not opened yet"]);
    });

    // 7000008 was already on 7100089 before the run. A month-wide `--date 2026-09 --remove 7000008`
    // would delete that pre-existing row too, so the undo must name each week and only what it got.
    test("undoes added rows week by week when a week already had one of the tasks", () => {
        const receipt = rowWriteReceipt({ outcomes: ADDED_TWO_WEEKS, date: "2026-09" });

        expect(receipt.undo).toBeUndefined();
        expect(receipt.undoEach).toEqual([
            ["tasks", "--timesheet", "7100092", "--remove", "7000005", "7000008"],
            ["tasks", "--timesheet", "7100089", "--remove", "7000005"],
        ]);
    });

    test("keeps one --date undo when every opened week got exactly the same rows", () => {
        const receipt = rowWriteReceipt({
            outcomes: [
                { timesheetId: 7100092, added: [{ taskId: 7000005 }], skipped: [], failed: [] },
                { timesheetId: 7100089, added: [{ taskId: 7000005 }], skipped: [], failed: [] },
                { unopened: true },
            ],
            date: "2026-09",
        });

        expect(receipt.undo).toEqual(["tasks", "--date", "2026-09", "--remove", "7000005"]);
        expect(receipt.undoEach).toBeUndefined();
    });

    test("puts removed rows back only on the weeks they were removed from", () => {
        const receipt = rowWriteReceipt({
            outcomes: [
                { timesheetId: 7100077, removed: [{ taskId: 7000032 }], blocked: [], failed: [], missing: [] },
                { timesheetId: 7100092, removed: [], blocked: [], failed: [], missing: [7000032] },
            ],
            date: "2026-09",
        });

        expect(receipt.undoEach).toEqual([["tasks", "--timesheet", "7100077", "--add", "7000032"]]);
    });

    test("offers no undo when every wanted row was already there", () => {
        const receipt = rowWriteReceipt({
            outcomes: [{ timesheetId: 7100077, added: [], skipped: [{ taskId: 7000005 }], failed: [] }],
            date: "2026-09",
        });

        expect(receipt).toEqual({ summary: ["1 row already there"] });
    });

    test("reports a refused row separately from a failed one", () => {
        const receipt = rowWriteReceipt({
            outcomes: [
                {
                    timesheetId: 7100071,
                    removed: [],
                    blocked: [{ taskId: 7000003, hours: 38.5 }],
                    failed: [{ taskId: 7000005, error: "boom" }],
                    missing: [],
                },
            ],
            date: "2026-08",
        });

        expect(receipt.summary).toEqual(["1 row kept because it carries hours", "1 row failed"]);
    });

    test("undoes removed rows by adding the same task ids back", () => {
        const receipt = rowWriteReceipt({
            outcomes: [{ timesheetId: 7100086, removed: [{ taskId: 7000032 }], blocked: [], failed: [], missing: [] }],
            date: "2026-09-28",
        });

        expect(receipt.summary).toEqual(["1 row removed"]);
        expect(receipt.undo).toEqual(["tasks", "--date", "2026-09-28", "--add", "7000032"]);
    });

    // With --timesheet the date is only the default (today), so a --date undo would touch the
    // weeks of today instead of the week that was written.
    test("names the timesheet when --timesheet chose the week, even for one uniform change", () => {
        const receipt = rowWriteReceipt({
            outcomes: [{ timesheetId: 7100086, added: [{ taskId: 7000005 }], skipped: [], failed: [] }],
        });

        expect(receipt.undo).toBeUndefined();
        expect(receipt.undoEach).toEqual([["tasks", "--timesheet", "7100086", "--remove", "7000005"]]);
    });
});
