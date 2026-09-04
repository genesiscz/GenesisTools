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
            mapping(302920, 8898018, "266796_Provoz"),
            mapping(298326, 8902059, "D_271735_Technologický dluh"),
        ]);

        expect(receipt.undo).toEqual(["mappings", "--assign", "302920:8898018", "298326:8902059"]);
    });

    test("counts what was removed", () => {
        const receipt = unlinkReceipt([mapping(302920, 8898018, "266796_Provoz")]);

        expect(receipt.summary).toEqual(["1 mapping removed"]);
    });

    test("pluralises the count", () => {
        const receipt = unlinkReceipt([
            mapping(302920, 8898018, "266796_Provoz"),
            mapping(298326, 8902059, "D_271735_Technologický dluh"),
        ]);

        expect(receipt.summary).toEqual(["2 mappings removed"]);
    });

    test("offers no undo when nothing was removed", () => {
        expect(unlinkReceipt([])).toEqual({ summary: [] });
    });
});

describe("assignReceipt", () => {
    test("counts created and replaced mappings apart", () => {
        const receipt = assignReceipt({
            created: [{ workItemId: 302920, clarityTaskId: 8898018 }],
            replaced: [{ workItemId: 298326, clarityTaskId: 8902059, previousClarityTaskId: 8902012 }],
        });

        expect(receipt.summary).toEqual(["1 mapping created", "1 mapping replaced"]);
    });

    // A created mapping is undone by removing it; a replaced one is undone by putting the previous
    // task back. Unlinking a replaced work item would throw away a mapping that predates the run.
    test("undoes a created mapping by unlinking it and a replaced one by restoring its old task", () => {
        const receipt = assignReceipt({
            created: [{ workItemId: 302920, clarityTaskId: 8898018 }],
            replaced: [{ workItemId: 298326, clarityTaskId: 8902059, previousClarityTaskId: 8902012 }],
        });

        expect(receipt.undo).toEqual(["mappings", "--assign", "298326:8902012", "--unlink", "302920"]);
    });

    test("omits the unlink half when nothing was created", () => {
        const receipt = assignReceipt({
            created: [],
            replaced: [{ workItemId: 298326, clarityTaskId: 8902059, previousClarityTaskId: 8902012 }],
        });

        expect(receipt.undo).toEqual(["mappings", "--assign", "298326:8902012"]);
    });

    test("omits the assign half when nothing was replaced", () => {
        const receipt = assignReceipt({ created: [{ workItemId: 302920, clarityTaskId: 8898018 }], replaced: [] });

        expect(receipt.undo).toEqual(["mappings", "--unlink", "302920"]);
    });

    test("offers no undo when nothing changed", () => {
        expect(assignReceipt({ created: [], replaced: [] })).toEqual({ summary: [] });
    });
});

describe("rowWriteReceipt", () => {
    const ADDED_TWO_WEEKS = [
        { timesheetId: 9115192, added: [{ taskId: 8902005 }, { taskId: 8902008 }], skipped: [], failed: [] },
        { timesheetId: 9115189, added: [{ taskId: 8902005 }], skipped: [{ taskId: 8902008 }], failed: [] },
        { unopened: true },
    ];

    test("counts rows across every week, and the weeks Clarity has not opened", () => {
        const receipt = rowWriteReceipt({ outcomes: ADDED_TWO_WEEKS, date: "2026-09" });

        expect(receipt.summary).toEqual(["3 rows added", "1 row already there", "1 week not opened yet"]);
    });

    // The undo names each task ONCE even though it was added to two weeks, because --remove takes
    // task ids and the same --date puts both weeks back in scope.
    test("undoes added rows with --remove over the same date, listing each task once", () => {
        const receipt = rowWriteReceipt({ outcomes: ADDED_TWO_WEEKS, date: "2026-09" });

        expect(receipt.undo).toEqual(["tasks", "--date", "2026-09", "--remove", "8902005", "8902008"]);
    });

    test("offers no undo when every wanted row was already there", () => {
        const receipt = rowWriteReceipt({
            outcomes: [{ timesheetId: 9115177, added: [], skipped: [{ taskId: 8902005 }], failed: [] }],
            date: "2026-09",
        });

        expect(receipt).toEqual({ summary: ["1 row already there"] });
    });

    test("reports a refused row separately from a failed one", () => {
        const receipt = rowWriteReceipt({
            outcomes: [
                {
                    timesheetId: 9115171,
                    removed: [],
                    blocked: [{ taskId: 8902012, hours: 38.5 }],
                    failed: [{ taskId: 8902005, error: "boom" }],
                    missing: [],
                },
            ],
            date: "2026-08",
        });

        expect(receipt.summary).toEqual(["1 row kept because it carries hours", "1 row failed"]);
    });

    test("undoes removed rows by adding the same task ids back", () => {
        const receipt = rowWriteReceipt({
            outcomes: [{ timesheetId: 9115186, removed: [{ taskId: 8902032 }], blocked: [], failed: [], missing: [] }],
            date: "2026-09-28",
        });

        expect(receipt.summary).toEqual(["1 row removed"]);
        expect(receipt.undo).toEqual(["tasks", "--date", "2026-09-28", "--add", "8902032"]);
    });
});
