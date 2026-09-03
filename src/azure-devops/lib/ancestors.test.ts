import { describe, expect, test } from "bun:test";
import { type WorkItemNode, walkAncestors } from "@app/azure-devops/lib/ancestors";

const TREE: Record<number, WorkItemNode> = {
    400001: { id: 400001, title: "FE analýza - leaf task", type: "Task", parent: 400002 },
    400002: { id: 400002, title: "Parent user story", type: "User Story", parent: 400003 },
    400003: { id: 400003, title: "Grandparent feature", type: "Feature", parent: 400004 },
    400004: { id: 400004, title: "Great-grandparent epic", type: "Epic" },
    500001: { id: 500001, title: "Orphan bug", type: "Bug" },
    600001: { id: 600001, title: "Cycle a", type: "Task", parent: 600002 },
    600002: { id: 600002, title: "Cycle b", type: "Task", parent: 600001 },
};

function tracingFetch() {
    const calls: number[] = [];

    return {
        calls,
        fetch: async (id: number): Promise<WorkItemNode | null> => {
            calls.push(id);

            return TREE[id] ?? null;
        },
    };
}

describe("walkAncestors", () => {
    test("returns the item first, then each ancestor in order", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 400001, maxDepth: 3 });

        expect(chain.map((node) => node.id)).toEqual([400001, 400002, 400003, 400004]);
    });

    test("stops climbing at maxDepth ancestors above the item", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 400001, maxDepth: 1 });

        expect(chain.map((node) => node.id)).toEqual([400001, 400002]);
    });

    test("returns the item alone when it has no parent", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 500001, maxDepth: 3 });

        expect(chain.map((node) => node.id)).toEqual([500001]);
    });

    test("stops instead of looping when the parent chain cycles back", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 600001, maxDepth: 3 });

        expect(chain.map((node) => node.id)).toEqual([600001, 600002]);
    });

    test("fetches each work item exactly once", async () => {
        const { calls, fetch } = tracingFetch();

        await walkAncestors({ fetch, id: 400001, maxDepth: 3 });

        expect(calls).toEqual([400001, 400002, 400003, 400004]);
    });

    test("returns an empty chain when the work item does not exist", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 999999, maxDepth: 3 });

        expect(chain).toEqual([]);
    });
});
