import { describe, expect, test } from "bun:test";
import { looksLikeWiql } from "@app/azure-devops/lib/wiql-input";

describe("looksLikeWiql", () => {
    test("recognises a single-line WIQL statement", () => {
        expect(looksLikeWiql("SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'")).toBe(true);
    });

    test("recognises a multi-line WIQL statement", () => {
        const wiql = [
            "SELECT [System.Id] FROM WorkItems",
            "WHERE [System.History] CONTAINS 'Example'",
            "  AND [System.ChangedDate] >= @today-7",
            "ORDER BY [System.ChangedDate] DESC",
        ].join("\n");

        expect(looksLikeWiql(wiql)).toBe(true);
    });

    test("is case-insensitive", () => {
        expect(looksLikeWiql("select [system.id] from workitems")).toBe(true);
    });

    test("recognises a link query", () => {
        expect(looksLikeWiql("SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] = 1")).toBe(true);
    });

    test("accepts an ordinary saved query name", () => {
        expect(looksLikeWiql("Sample19 - ALL Bugs - Open & Closed")).toBe(false);
        expect(looksLikeWiql("Incidenty_Opex")).toBe(false);
        expect(looksLikeWiql("My team's open work")).toBe(false);
    });

    test("accepts a query name that merely reads like English with the word select in it", () => {
        expect(looksLikeWiql("Select from the current sprint")).toBe(false);
    });

    test("accepts a query id and a query URL", () => {
        expect(looksLikeWiql("a1b2c3d4-1111-2222-3333-444455556666")).toBe(false);
        expect(
            looksLikeWiql("https://example.invalid/org/project/_queries/query/a1b2c3d4-1111-2222-3333-444455556666")
        ).toBe(false);
    });
});
