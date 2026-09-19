import { describe, expect, test } from "bun:test";
import { workItemJsonStdout } from "@app/azure-devops/commands/workitem";
import type { WorkItemFull } from "@app/azure-devops/types";
import { SafeJSON } from "@genesiscz/utils/json";

function item(id: number, title: string): WorkItemFull {
    return {
        id,
        rev: 1,
        title,
        state: "Active",
        changed: "2026-09-17T00:00:00Z",
        url: `https://dev.azure.com/example/proj/_workitems/edit/${id}`,
        comments: [],
    };
}

describe("workItemJsonStdout", () => {
    test("empty list is a JSON array", () => {
        const raw = workItemJsonStdout([]);
        const parsed = SafeJSON.parse(raw);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toEqual([]);
    });

    test("one work item is still a JSON array (stable shape for scripts)", () => {
        const raw = workItemJsonStdout([item(111111, "One")]);
        const parsed = SafeJSON.parse(raw) as WorkItemFull[];
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.id).toBe(111111);
        expect(parsed[0]?.title).toBe("One");
    });

    test("many work items are one JSON array, not concatenated objects", () => {
        const raw = workItemJsonStdout([item(111111, "A"), item(222222, "B"), item(333333, "C")]);
        // Must parse as a single JSON value — concatenated `{...}{...}` throws.
        const parsed = SafeJSON.parse(raw) as WorkItemFull[];
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.map((w) => w.id)).toEqual([111111, 222222, 333333]);
        expect(raw).not.toContain("---");
    });
});
