import { describe, expect, test } from "bun:test";
import { type WorkItemNode, walkAncestorsBatched } from "@app/azure-devops/lib/ancestors";

const TREE: Record<number, WorkItemNode> = {
    100001: { id: 100001, title: "Leaf a", type: "Task", parent: 200001 },
    100002: { id: 100002, title: "Leaf b", type: "Task", parent: 200001 },
    100003: { id: 100003, title: "Leaf c", type: "Task", parent: 200002 },
    200001: { id: 200001, title: "Story a", type: "User Story", parent: 300001 },
    200002: { id: 200002, title: "Story b", type: "User Story", parent: 300001 },
    300001: { id: 300001, title: "Feature", type: "Feature", parent: 400001 },
    400001: { id: 400001, title: "Epic", type: "Epic" },
    500001: { id: 500001, title: "Orphan", type: "Bug" },
};

function batchFetcher() {
    const batches: number[][] = [];

    return {
        batches,
        fetchMany: async (ids: number[]): Promise<Map<number, WorkItemNode>> => {
            batches.push([...ids]);

            return new Map(ids.filter((id) => TREE[id]).map((id) => [id, TREE[id]]));
        },
    };
}

describe("walkAncestorsBatched", () => {
    test("returns a full chain for every requested work item", async () => {
        const { fetchMany } = batchFetcher();

        const chains = await walkAncestorsBatched({ fetchMany, ids: [100001, 100003], maxDepth: 3 });

        expect(chains.get(100001)?.map((n) => n.id)).toEqual([100001, 200001, 300001, 400001]);
        expect(chains.get(100003)?.map((n) => n.id)).toEqual([100003, 200002, 300001, 400001]);
    });

    test("spends one fetch per tree level, not one per work item", async () => {
        const { batches, fetchMany } = batchFetcher();

        await walkAncestorsBatched({ fetchMany, ids: [100001, 100002, 100003], maxDepth: 3 });

        expect(batches).toEqual([[100001, 100002, 100003], [200001, 200002], [300001], [400001]]);
    });

    test("never asks for a work item it already holds", async () => {
        const { batches, fetchMany } = batchFetcher();

        await walkAncestorsBatched({ fetchMany, ids: [100001, 100002], maxDepth: 3 });

        const requested = batches.flat();

        expect(requested.length).toBe(new Set(requested).size);
    });

    test("returns a single-node chain for a work item with no parent", async () => {
        const { fetchMany } = batchFetcher();

        const chains = await walkAncestorsBatched({ fetchMany, ids: [500001], maxDepth: 3 });

        expect(chains.get(500001)?.map((n) => n.id)).toEqual([500001]);
    });

    test("omits a work item the server does not return", async () => {
        const { fetchMany } = batchFetcher();

        const chains = await walkAncestorsBatched({ fetchMany, ids: [999999], maxDepth: 3 });

        expect(chains.has(999999)).toBe(false);
    });

    test("stops climbing at maxDepth ancestors above each item", async () => {
        const { fetchMany } = batchFetcher();

        const chains = await walkAncestorsBatched({ fetchMany, ids: [100001], maxDepth: 1 });

        expect(chains.get(100001)?.map((n) => n.id)).toEqual([100001, 200001]);
    });
});
