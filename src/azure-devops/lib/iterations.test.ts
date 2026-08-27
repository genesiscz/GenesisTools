import { describe, expect, test } from "bun:test";
import type { TeamIteration } from "@app/azure-devops/api.types";
import { findCurrentIteration, iterationContainsDate, resolveIteration } from "@app/azure-devops/lib/iterations";

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
