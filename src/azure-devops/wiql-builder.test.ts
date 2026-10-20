import { describe, expect, test } from "bun:test";
import { buildCombinedQuery, wiqlRequestsTimePrecision, wiqlTimePrecisionParam } from "@app/azure-devops/wiql-builder";

describe("buildCombinedQuery", () => {
    test("scopes to the configured project and matches the current assignee with =", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "Nováková Jana (Contractor)" });

        expect(wiql).toContain("[System.TeamProject] = @project");
        expect(wiql).toContain("[System.AssignedTo] = 'Nováková Jana (Contractor)'");
    });

    test("assigneeContains switches the current-assignee predicate to CONTAINS", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "Smith", assigneeContains: true });

        expect(wiql).toContain("[System.AssignedTo] CONTAINS 'Smith'");
        expect(wiql).not.toContain("EVER");
    });

    test("assigneeContains never applies to the @Me macro", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "@Me", assigneeContains: true, isMacro: true });

        expect(wiql).toContain("[System.AssignedTo] = @Me");
    });

    test("EVER assignment keeps = even when assigneeContains is set", () => {
        const wiql = buildCombinedQuery({ assignedTo: "Smith John (Vendor)", assigneeContains: true });

        expect(wiql).toContain("EVER [System.AssignedTo] = 'Smith John (Vendor)'");
    });

    test("excludeStates emits NOT IN and coexists with states", () => {
        const wiql = buildCombinedQuery({ states: "Active, Blocked", excludeStates: "Closed,Removed" });

        expect(wiql).toContain("[System.State] IN ('Active', 'Blocked')");
        expect(wiql).toContain("[System.State] NOT IN ('Closed', 'Removed')");
    });

    test("allProjects drops the project predicate", () => {
        const wiql = buildCombinedQuery({ allProjects: true, excludeStates: "Closed" });

        expect(wiql).not.toContain("System.TeamProject");
        expect(wiql).toContain("WHERE [System.State] NOT IN ('Closed')");
    });

    test("allProjects with no other filter still produces a valid WHERE clause", () => {
        const wiql = buildCombinedQuery({ allProjects: true });

        expect(wiql).toContain("WHERE [System.Id] > 0");
    });

    test("escapes single quotes in values", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "O'Neil", assigneeContains: true });

        expect(wiql).toContain("CONTAINS 'O''Neil'");
    });
});

describe("wiql time precision", () => {
    test("a clock in a ChangedDate literal asks for time precision", () => {
        const wiql = "AND [System.ChangedDate] >= '2026-10-15T02:12:15.000Z'";

        expect(wiqlRequestsTimePrecision(wiql)).toBe(true);
        expect(wiqlTimePrecisionParam(wiql)).toBe("true");
    });

    test("a space-separated clock asks for time precision too", () => {
        expect(wiqlRequestsTimePrecision("AND [System.ChangedDate] >= '2026-10-15 02:12:15'")).toBe(true);
    });

    test("a bare day stays on date precision", () => {
        const wiql = "AND [System.ChangedDate] >= '2026-10-15' ORDER BY [System.ChangedDate] DESC";

        expect(wiqlRequestsTimePrecision(wiql)).toBe(false);
        expect(wiqlTimePrecisionParam(wiql)).toBeUndefined();
    });

    test("an explicit false keeps date precision even when the literal has a clock", () => {
        expect(wiqlTimePrecisionParam("[System.ChangedDate] >= '2026-10-15T02:12:15.000Z'", false)).toBeUndefined();
    });
});
