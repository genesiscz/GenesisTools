import { describe, expect, test } from "bun:test";
import type { IterationClassificationNode, TeamIteration } from "@app/azure-devops/api.types";
import {
    describeIterationSource,
    findCurrentIteration,
    flattenIterationNodes,
    iterationContainsDate,
    resolveIteration,
    toIterationPath,
} from "@app/azure-devops/lib/iterations";

function iteration(name: string, start: string, finish: string, project = "Widgets"): TeamIteration {
    return {
        id: `id-${name}`,
        name,
        path: `${project}\\${name}`,
        attributes: { startDate: `${start}T00:00:00Z`, finishDate: `${finish}T00:00:00Z` },
    };
}

const ITERATIONS: TeamIteration[] = [
    iteration("Q3 Sprint 4", "2026-08-06", "2026-08-19"),
    iteration("Q3 Sprint 5", "2026-08-20", "2026-09-02"),
    iteration("Q3 Sprint 6", "2026-09-03", "2026-09-16"),
];

describe("iterationContainsDate", () => {
    test("includes the start day", () => {
        expect(iterationContainsDate(ITERATIONS[1], new Date(2026, 7, 20, 9, 0))).toBe(true);
    });

    test("includes the finish day, not just the midnight boundary", () => {
        expect(iterationContainsDate(ITERATIONS[1], new Date(2026, 8, 2, 23, 30))).toBe(true);
    });

    test("excludes the day after the finish day", () => {
        expect(iterationContainsDate(ITERATIONS[1], new Date(2026, 8, 3, 0, 1))).toBe(false);
    });

    test("an iteration without dates never contains a date", () => {
        const undated: TeamIteration = { id: "x", name: "Backlog", path: "Widgets" };
        expect(iterationContainsDate(undated, new Date(2026, 7, 27))).toBe(false);
    });
});

/**
 * Regression test: PR #333 review t9. `iterationContainsDate` compares a
 * UTC-derived date string (datePart slices the API's ISO timestamp) against a
 * LOCAL one (formatLocalDate reads getFullYear/getMonth/getDate). Sprint
 * boundaries are calendar days, so local is the semantic we want — but that
 * only holds if the comparison is pinned, because a timestamp comparison here
 * would silently drop the whole final day.
 */
describe("iterationContainsDate across the local midnight boundary", () => {
    const withTz = (tz: string, run: () => void): void => {
        const original = process.env.TZ;
        process.env.TZ = tz;

        try {
            run();
        } finally {
            process.env.TZ = original;
        }
    };

    const sprint = ITERATIONS[1]; // 2026-08-20 .. 2026-09-02

    test("the last day counts until local midnight, not until the UTC timestamp", () => {
        // 23:59 local on the finish day is still inside the sprint.
        expect(iterationContainsDate(sprint, new Date(2026, 8, 2, 23, 59))).toBe(true);
        // 00:01 local the next day is not.
        expect(iterationContainsDate(sprint, new Date(2026, 8, 3, 0, 1))).toBe(false);
    });

    test("the first day counts from local midnight", () => {
        expect(iterationContainsDate(sprint, new Date(2026, 7, 20, 0, 0))).toBe(true);
        expect(iterationContainsDate(sprint, new Date(2026, 7, 19, 23, 59))).toBe(false);
    });

    test("a timezone far from UTC still resolves by local calendar day", () => {
        withTz("Pacific/Auckland", () => {
            expect(iterationContainsDate(sprint, new Date(2026, 8, 2, 12, 0))).toBe(true);
            expect(iterationContainsDate(sprint, new Date(2026, 8, 3, 12, 0))).toBe(false);
        });

        withTz("America/Los_Angeles", () => {
            expect(iterationContainsDate(sprint, new Date(2026, 7, 20, 12, 0))).toBe(true);
            expect(iterationContainsDate(sprint, new Date(2026, 7, 19, 12, 0))).toBe(false);
        });
    });
});

describe("findCurrentIteration", () => {
    test("picks the iteration whose range contains today", () => {
        const current = findCurrentIteration(ITERATIONS, new Date(2026, 7, 27));
        expect(current?.name).toBe("Q3 Sprint 5");
    });

    test("returns null when no range contains today", () => {
        expect(findCurrentIteration(ITERATIONS, new Date(2026, 0, 15))).toBeNull();
    });
});

describe("resolveIteration", () => {
    const now = new Date(2026, 7, 27);

    test("resolves an exact iteration path", () => {
        const result = resolveIteration(ITERATIONS, "Widgets\\Q3 Sprint 5", now);
        expect(result).toMatchObject({ kind: "resolved", matchedBy: "path" });
    });

    test("path match is case-insensitive", () => {
        const result = resolveIteration(ITERATIONS, "widgets\\q3 sprint 5", now);
        expect(result).toMatchObject({ kind: "resolved", matchedBy: "path" });
    });

    test("resolves an exact iteration name", () => {
        const result = resolveIteration(ITERATIONS, "Q3 Sprint 5", now);
        expect(result).toMatchObject({ kind: "resolved", matchedBy: "name" });
    });

    test("resolves a unique case-insensitive substring", () => {
        const result = resolveIteration(ITERATIONS, "sprint 5", now);

        if (result.kind !== "resolved") {
            throw new Error(`expected resolved, got ${result.kind}`);
        }

        expect(result.iteration.name).toBe("Q3 Sprint 5");
        expect(result.matchedBy).toBe("substring");
    });

    test("path form and substring form resolve to the same iteration", () => {
        const byPath = resolveIteration(ITERATIONS, "Widgets\\Q3 Sprint 5", now);
        const bySubstring = resolveIteration(ITERATIONS, "Sprint 5", now);

        if (byPath.kind !== "resolved" || bySubstring.kind !== "resolved") {
            throw new Error("both forms must resolve");
        }

        expect(byPath.iteration.path).toBe(bySubstring.iteration.path);
    });

    test("refuses an ambiguous substring and lists every candidate", () => {
        const result = resolveIteration(ITERATIONS, "Sprint", now);

        if (result.kind !== "ambiguous") {
            throw new Error(`expected ambiguous, got ${result.kind}`);
        }

        expect(result.candidates).toHaveLength(3);
    });

    test("an empty argument resolves the iteration containing today", () => {
        const result = resolveIteration(ITERATIONS, undefined, now);
        expect(result).toMatchObject({ kind: "resolved", matchedBy: "current" });
    });

    test('the literal "current" resolves by date range too', () => {
        const result = resolveIteration(ITERATIONS, "current", now);
        expect(result).toMatchObject({ kind: "resolved", matchedBy: "current" });
    });

    test("reports no-current when nothing contains today", () => {
        expect(resolveIteration(ITERATIONS, undefined, new Date(2026, 0, 15))).toEqual({ kind: "no-current" });
    });

    test("reports not-found for a query that matches nothing", () => {
        expect(resolveIteration(ITERATIONS, "Sprint 99", now)).toEqual({ kind: "not-found", query: "Sprint 99" });
    });
});

describe("toIterationPath", () => {
    test("strips the leading backslash and the Iteration segment", () => {
        expect(toIterationPath("\\Widgets\\Iteration\\Sprint 17")).toBe("Widgets\\Sprint 17");
    });

    test("keeps a nested release folder below the Iteration segment", () => {
        expect(toIterationPath("\\Widgets\\Iteration\\Release 3\\Sprint 17")).toBe("Widgets\\Release 3\\Sprint 17");
    });

    test("the project root node collapses to the project name", () => {
        expect(toIterationPath("\\Widgets\\Iteration")).toBe("Widgets");
    });

    test("a path already in System.IterationPath form is left alone", () => {
        expect(toIterationPath("Widgets\\Sprint 17")).toBe("Widgets\\Sprint 17");
    });

    test("only the Iteration segment goes, not a sprint whose name starts with it", () => {
        expect(toIterationPath("\\Widgets\\Iteration\\Iteration planning")).toBe("Widgets\\Iteration planning");
    });
});

describe("flattenIterationNodes", () => {
    const ROOT: IterationClassificationNode = {
        id: 1,
        identifier: "00000000-0000-0000-0000-000000000001",
        name: "Widgets",
        path: "\\Widgets\\Iteration",
        structureType: "iteration",
        hasChildren: true,
        children: [
            {
                id: 2,
                identifier: "00000000-0000-0000-0000-000000000002",
                name: "Sprint 16",
                path: "\\Widgets\\Iteration\\Sprint 16",
                attributes: { startDate: "2026-08-06T00:00:00Z", finishDate: "2026-08-19T00:00:00Z" },
            },
            {
                id: 3,
                identifier: "00000000-0000-0000-0000-000000000003",
                name: "Release 3",
                path: "\\Widgets\\Iteration\\Release 3",
                hasChildren: true,
                children: [
                    {
                        id: 4,
                        identifier: "00000000-0000-0000-0000-000000000004",
                        name: "Sprint 17",
                        path: "\\Widgets\\Iteration\\Release 3\\Sprint 17",
                        attributes: { startDate: "2026-08-20T00:00:00Z", finishDate: "2026-09-02T00:00:00Z" },
                    },
                ],
            },
        ],
    };

    test("normalises every path to System.IterationPath form", () => {
        expect(flattenIterationNodes(ROOT).map((it) => it.path)).toEqual([
            "Widgets\\Sprint 16",
            "Widgets\\Release 3\\Sprint 17",
        ]);
    });

    test("drops undated container nodes: the project root and the release folder", () => {
        expect(flattenIterationNodes(ROOT).map((it) => it.name)).toEqual(["Sprint 16", "Sprint 17"]);
    });

    test("carries the node guid and both dates through", () => {
        expect(flattenIterationNodes(ROOT)[0]).toEqual({
            id: "00000000-0000-0000-0000-000000000002",
            name: "Sprint 16",
            path: "Widgets\\Sprint 16",
            attributes: { startDate: "2026-08-06T00:00:00Z", finishDate: "2026-08-19T00:00:00Z" },
        });
    });

    test("the flattened list feeds resolveIteration unchanged", () => {
        const flat = flattenIterationNodes(ROOT);
        expect(resolveIteration(flat, undefined, new Date(2026, 7, 27))).toMatchObject({
            kind: "resolved",
            matchedBy: "current",
        });
    });
});

describe("describeIterationSource", () => {
    test("names the team and the row count", () => {
        expect(describeIterationSource({ kind: "team", team: "Payments Team", count: 22 })).toBe(
            'team "Payments Team" (22 iterations)'
        );
    });

    test("names the project fallback and the row count", () => {
        expect(describeIterationSource({ kind: "project", team: null, count: 26 })).toBe(
            "project classification nodes (26 iterations)"
        );
    });
});
