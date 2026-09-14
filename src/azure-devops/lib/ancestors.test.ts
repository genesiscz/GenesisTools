import { describe, expect, test } from "bun:test";
import { type WorkItemNode, walkAncestors } from "@app/azure-devops/lib/ancestors";

const TREE: Record<number, WorkItemNode> = {
    400001: { id: 400001, title: "FE analýza - leaf task", type: "Task", parent: 400002 },
    400002: { id: 400002, title: "Parent user story", type: "User Story", parent: 400003 },
    400003: { id: 400003, title: "Grandparent feature", type: "Feature", parent: 400004 },
    400004: { id: 400004, title: "Great-grandparent epic", type: "Epic" },
    410001: { id: 410001, title: "Deep leaf task", type: "Task", parent: 410002 },
    410002: { id: 410002, title: "Deep user story", type: "User Story", parent: 410003 },
    410003: { id: 410003, title: "Deep feature", type: "Feature", parent: 410004 },
    410004: { id: 410004, title: "Deep umbrella feature", type: "Feature", parent: 410005 },
    410005: { id: 410005, title: "Deep epic", type: "Epic" },
    500001: { id: 500001, title: "Orphan bug", type: "Bug" },
    600001: { id: 600001, title: "Cycle a", type: "Task", parent: 600002 },
    600002: { id: 600002, title: "Cycle b", type: "Task", parent: 600001 },
    610001: { id: 610001, title: "Its own parent", type: "Task", parent: 610001 },
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

    test("climbs to the root when no depth is given, past the old ceiling of three", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 410001 });

        expect(chain.map((node) => node.id)).toEqual([410001, 410002, 410003, 410004, 410005]);
    });

    test("still honours an explicit cap on a chain deeper than the cap", async () => {
        const { fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 410001, maxDepth: 2 });

        expect(chain.map((node) => node.id)).toEqual([410001, 410002, 410003]);
    });

    test("stops instead of looping on a cyclic chain when no depth is given", async () => {
        const { calls, fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 600001 });

        expect(chain.map((node) => node.id)).toEqual([600001, 600002]);
        expect(calls).toEqual([600001, 600002]);
    });

    test("stops on a work item that is its own parent", async () => {
        const { calls, fetch } = tracingFetch();

        const chain = await walkAncestors({ fetch, id: 610001 });

        expect(chain.map((node) => node.id)).toEqual([610001]);
        expect(calls).toEqual([610001]);
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
