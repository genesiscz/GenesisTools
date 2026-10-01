import { describe, expect, test } from "bun:test";
import {
    buildQueryTreeView,
    displayFieldValue,
    FALLBACK_QUERY_COLUMNS,
    formatQueryTreeMarkdown,
    formatQueryTreeText,
    relationsFromQueryResult,
    workItemIdsFromQueryResult,
} from "@app/azure-devops/lib/query-tree";

const columns = [
    { name: "ID", referenceName: "System.Id" },
    { name: "Work Item Type", referenceName: "System.WorkItemType" },
    { name: "Title", referenceName: "System.Title" },
    { name: "Assigned To", referenceName: "System.AssignedTo" },
    { name: "Merge proběhl", referenceName: "Custom.MergeProbehl" },
];

describe("workItemIdsFromQueryResult", () => {
    test("reads a tree result that has no workItems array", () => {
        const ids = workItemIdsFromQueryResult({
            workItemRelations: [
                { source: null, target: { id: 1 } },
                { source: { id: 1 }, target: { id: 2 } },
            ],
        });

        expect(ids).toEqual([1, 2]);
    });

    test("keeps a flat list in order and ignores a repeated id", () => {
        expect(
            workItemIdsFromQueryResult({
                workItems: [{ id: 4 }, { id: 4 }, { id: 9 }],
            })
        ).toEqual([4, 9]);
    });
});

describe("relationsFromQueryResult", () => {
    test("turns a flat result into roots", () => {
        expect(relationsFromQueryResult({ workItems: [{ id: 7 }, { id: 8 }] })).toEqual([
            { sourceId: null, targetId: 7 },
            { sourceId: null, targetId: 8 },
        ]);
    });

    test("prefers link rows over a workItems list", () => {
        expect(
            relationsFromQueryResult({
                workItems: [{ id: 1 }],
                workItemRelations: [{ source: { id: 1 }, target: { id: 2 } }],
            })
        ).toEqual([{ sourceId: 1, targetId: 2 }]);
    });
});

describe("displayFieldValue", () => {
    test("uses an identity display name and keeps an explicit N/A", () => {
        expect(displayFieldValue({ displayName: "Nováková Jana" })).toBe("Nováková Jana");
        expect(displayFieldValue("N/A")).toBe("N/A");
        expect(displayFieldValue("  ")).toBeNull();
        expect(displayFieldValue(0)).toBe("0");
    });

    test("strips html without eating a title that merely contains a less-than", () => {
        expect(displayFieldValue('<a href="https://gitlab.example/1">https://gitlab.example/1</a>')).toBe(
            "https://gitlab.example/1"
        );
        expect(displayFieldValue("2 < 3")).toBe("2 < 3");
    });
});

describe("buildQueryTreeView", () => {
    const fields = new Map<number, Record<string, unknown>>([
        [
            1,
            {
                "System.WorkItemType": "Incident",
                "System.Title": "Parent",
                "System.AssignedTo": { displayName: "Dvořák Petr" },
                "Custom.MergeProbehl": "Ano",
            },
        ],
        [
            2,
            {
                "System.WorkItemType": "Task",
                "System.Title": "FE task",
                "Custom.MergeProbehl": null,
            },
        ],
    ]);

    test("nests children and prints an empty merge column instead of dropping it", () => {
        const view = buildQueryTreeView({
            id: "q",
            name: "Release 8.10.2026",
            path: "Shared Queries/RELEASE 2026/Release 8.10.2026",
            queryType: "tree",
            wiql: "select [System.Id] from WorkItemLinks",
            asOf: "2026-09-29T12:00:00Z",
            columns,
            relations: [
                { sourceId: null, targetId: 1 },
                { sourceId: 1, targetId: 2 },
            ],
            fieldsById: fields,
            urlFor: (id) => `https://example.test/${id}`,
        });

        expect(view.roots).toHaveLength(1);
        expect(view.roots[0]?.children.map((child) => child.id)).toEqual([2]);
        expect(view.roots[0]?.url).toBe("https://example.test/1");
        expect(view.roots[0]?.values["Merge proběhl"]).toBe("Ano");
        expect(view.roots[0]?.children[0]?.values["Merge proběhl"]).toBeNull();
        expect(formatQueryTreeText(view)).toBe(
            [
                "# Release 8.10.2026",
                "Shared Queries/RELEASE 2026/Release 8.10.2026",
                "tree · 2 work items · as of 2026-09-29T12:00:00Z",
                "",
                "1 | Incident | Parent | Assigned To: Dvořák Petr | Merge proběhl: Ano",
                "  2 | Task | FE task | Assigned To: — | Merge proběhl: —",
            ].join("\n")
        );
        expect(formatQueryTreeMarkdown(view)).toContain("\n- 1 | Incident | Parent");
        expect(formatQueryTreeMarkdown(view)).toContain("\n  - 2 | Task | FE task");
    });

    test("keeps a disconnected parent as its own root", () => {
        const view = buildQueryTreeView({
            id: "q",
            name: "Q",
            path: "P",
            queryType: "tree",
            wiql: null,
            asOf: null,
            columns: FALLBACK_QUERY_COLUMNS,
            relations: [
                { sourceId: null, targetId: 1 },
                { sourceId: 5, targetId: 6 },
            ],
            fieldsById: new Map(),
            urlFor: (id) => String(id),
        });

        expect(view.roots.map((root) => root.id)).toEqual([1, 5]);
        expect(view.roots[1]?.children.map((child) => child.id)).toEqual([6]);
    });

    test("stops a cycle and says how many rows that added", () => {
        const view = buildQueryTreeView({
            id: "q",
            name: "Q",
            path: "P",
            queryType: "tree",
            wiql: null,
            asOf: null,
            columns,
            relations: [
                { sourceId: null, targetId: 1 },
                { sourceId: 1, targetId: 2 },
                { sourceId: 2, targetId: 1 },
            ],
            fieldsById: fields,
        });

        expect(view.roots[0]?.children[0]?.children.map((node) => node.id)).toEqual([1]);
        expect(view.roots[0]?.children[0]?.children[0]?.children).toEqual([]);
        expect(formatQueryTreeText(view)).toContain("tree · 3 rows · 2 work items");
    });

    test("keeps a cycle that no root leads into", () => {
        const view = buildQueryTreeView({
            id: "q",
            name: "Q",
            path: "P",
            queryType: "oneHop",
            wiql: null,
            asOf: null,
            columns,
            relations: [
                { sourceId: 1, targetId: 2 },
                { sourceId: 2, targetId: 1 },
            ],
            fieldsById: fields,
        });

        // Both items stay: one becomes the root, the other its child, and the cycle guard stops there.
        expect(view.roots).toHaveLength(1);
        const root = view.roots[0];
        expect([root?.id, root?.children[0]?.id].sort()).toEqual([1, 2]);
    });

    test("does not repeat the same child edge", () => {
        const view = buildQueryTreeView({
            id: "q",
            name: "Q",
            path: "P",
            queryType: "oneHop",
            wiql: null,
            asOf: null,
            columns,
            relations: [
                { sourceId: 1, targetId: 2 },
                { sourceId: 1, targetId: 2 },
            ],
            fieldsById: fields,
        });

        expect(view.roots.map((root) => root.id)).toEqual([1]);
        expect(view.roots[0]?.children).toHaveLength(1);
    });
});
