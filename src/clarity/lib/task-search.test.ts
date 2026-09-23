import { describe, expect, test } from "bun:test";
import { mergeSearchHits, searchPrefixes } from "@app/clarity/lib/task-search";

describe("searchPrefixes", () => {
    // Clarity names a delivery task `D_<adoId>_…` and a standing one `<adoId>_…`, so an id alone
    // must search both. A task that is not on any timesheet yet is only reachable this way.
    test("an ADO id searches the delivery and the standing prefix", () => {
        expect(searchPrefixes("410001")).toEqual(["D_410001", "410001_"]);
    });

    test("any other text is searched as typed, trimmed", () => {
        expect(searchPrefixes("  Incidenty_Opex ")).toEqual(["Incidenty_Opex"]);
    });
});

describe("mergeSearchHits", () => {
    test("keeps each task once, sorted by name, and marks the ones already on the timesheet", () => {
        const hits = mergeSearchHits(
            [
                { term: "410001", results: [{ taskId: 2, code: "00002", name: "D_410001_Sample_B" }] },
                {
                    term: "D_410001",
                    results: [
                        { taskId: 1, code: "00001", name: "D_410001_Sample_A" },
                        { taskId: 2, code: "00002", name: "D_410001_Sample_B" },
                    ],
                },
            ],
            new Set([1])
        );

        expect(hits).toEqual([
            { taskId: 1, code: "00001", name: "D_410001_Sample_A", term: "D_410001", onTimesheet: true },
            { taskId: 2, code: "00002", name: "D_410001_Sample_B", term: "410001", onTimesheet: false },
        ]);
    });
});
