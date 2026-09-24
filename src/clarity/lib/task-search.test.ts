import { describe, expect, test } from "bun:test";
import { mergeSearchHits, searchPrefixes } from "@app/clarity/lib/task-search";

describe("searchPrefixes", () => {
    // Clarity names a delivery task `D_<adoId>_…` and a standing one `<adoId>_…`, so an id alone
    // must search both. A task that is not on any timesheet yet is only reachable this way.
    test("an ADO id searches the delivery and the standing prefix", () => {
        expect(searchPrefixes("410001")).toEqual(["D_410001_", "410001_"]);
    });

    test("both prefixes end at the id, so a longer id with the same digits is not found", () => {
        for (const prefix of searchPrefixes("410001")) {
            expect("D_4100019_Other".startsWith(prefix)).toBe(false);
            expect("4100019_Other".startsWith(prefix)).toBe(false);
        }
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
            { weeks: 1, byTask: new Map([[1, ["2026-09-01"]]]) }
        );

        expect(hits).toEqual([
            {
                taskId: 1,
                code: "00001",
                name: "D_410001_Sample_A",
                term: "D_410001",
                onTimesheet: true,
                onWeeks: ["2026-09-01"],
            },
            {
                taskId: 2,
                code: "00002",
                name: "D_410001_Sample_B",
                term: "410001",
                onTimesheet: false,
                onWeeks: [],
            },
        ]);
    });

    test("a task on only some weeks of the scope is not reported as on the timesheet", () => {
        const [hit] = mergeSearchHits(
            [{ term: "D_410001_", results: [{ taskId: 1, code: "00001", name: "D_410001_Sample_A" }] }],
            { weeks: 4, byTask: new Map([[1, ["2026-09-01", "2026-09-08"]]]) }
        );

        expect(hit?.onTimesheet).toBe(false);
        expect(hit?.onWeeks).toEqual(["2026-09-01", "2026-09-08"]);
    });

    test("no opened week means no task counts as on the timesheet", () => {
        const [hit] = mergeSearchHits([{ term: "x", results: [{ taskId: 1, code: "1", name: "x" }] }], {
            weeks: 0,
            byTask: new Map(),
        });

        expect(hit?.onTimesheet).toBe(false);
    });
});
