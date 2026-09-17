import { describe, expect, test } from "bun:test";
import { buildCombinedQuery } from "@app/azure-devops/wiql-builder";

describe("buildCombinedQuery", () => {
    test("scopes to the configured project and matches the current assignee with =", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "Kiefmann Karel (QK)" });

        expect(wiql).toContain("[System.TeamProject] = @project");
        expect(wiql).toContain("[System.AssignedTo] = 'Kiefmann Karel (QK)'");
    });

    test("assigneeContains switches the current-assignee predicate to CONTAINS", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "Prášil", assigneeContains: true });

        expect(wiql).toContain("[System.AssignedTo] CONTAINS 'Prášil'");
        expect(wiql).not.toContain("EVER");
    });

    test("assigneeContains never applies to the @Me macro", () => {
        const wiql = buildCombinedQuery({ currentAssignedTo: "@Me", assigneeContains: true, isMacro: true });

        expect(wiql).toContain("[System.AssignedTo] = @Me");
    });

    test("EVER assignment keeps = even when assigneeContains is set", () => {
        const wiql = buildCombinedQuery({ assignedTo: "Prášil Jan (QT)", assigneeContains: true });

        expect(wiql).toContain("EVER [System.AssignedTo] = 'Prášil Jan (QT)'");
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
