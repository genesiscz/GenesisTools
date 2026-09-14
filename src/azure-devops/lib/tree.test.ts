import { describe, expect, test } from "bun:test";
import { buildWorkItemTree } from "@app/azure-devops/lib/tree";
import type { WorkItemLinks } from "@app/azure-devops/types";

function item(overrides: Partial<WorkItemLinks> & { id: number }): WorkItemLinks {
    return {
        title: `Work item ${overrides.id}`,
        type: "Task",
        assignedTo: null,
        createdAt: "2026-01-02T03:04:05Z",
        updatedAt: "2026-02-03T04:05:06Z",
        childIds: [],
        relatedIds: [],
        ...overrides,
    };
}

const TREE: Record<number, WorkItemLinks> = {
    820001: item({
        id: 820001,
        title: "Leaf task",
        assignedTo: "Alice Example",
        parentId: 820002,
        childIds: [830001, 830002],
        relatedIds: [840001],
    }),
    820002: item({ id: 820002, title: "Parent story", type: "User Story", parentId: 820003 }),
    820003: item({ id: 820003, title: "Feature", type: "Feature", parentId: 820004 }),
    820004: item({ id: 820004, title: "Umbrella feature", type: "Feature", parentId: 820005 }),
    820005: item({ id: 820005, title: "Epic", type: "Epic" }),
    830001: item({ id: 830001, title: "First child", assignedTo: "Bob Example" }),
    830002: item({ id: 830002, title: "Second child" }),
    840001: item({ id: 840001, title: "Related bug", type: "Bug" }),
    850001: item({ id: 850001, title: "Item whose child is missing", childIds: [990001] }),
    860001: item({ id: 860001, title: "Cycle a", parentId: 860002 }),
    860002: item({ id: 860002, title: "Cycle b", parentId: 860001 }),
    860003: item({ id: 860003, title: "Its own parent", parentId: 860003 }),
    // 870003 is both the root's related item and its grandparent. Azure DevOps allows both links
    // on one pair, and the first request asks for the related item, so the grandparent is already
    // in hand by the time the climb reaches it.
    870001: item({
        id: 870001,
        title: "Leaf whose grandparent is also related",
        parentId: 870002,
        relatedIds: [870003],
    }),
    870002: item({ id: 870002, title: "Story", type: "User Story", parentId: 870003 }),
    870003: item({ id: 870003, title: "Feature, also linked as related", type: "Feature", parentId: 870004 }),
    870004: item({ id: 870004, title: "Epic above the related feature", type: "Epic" }),
};

function fetcher(tree: Record<number, WorkItemLinks> = TREE) {
    const batches: number[][] = [];

    return {
        batches,
        fetchMany: async (ids: number[]): Promise<Map<number, WorkItemLinks>> => {
            batches.push([...ids]);

            return new Map(ids.filter((id) => tree[id]).map((id) => [id, tree[id]]));
        },
    };
}

describe("buildWorkItemTree", () => {
    test("returns the item with its own fields", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 820001 });

        expect(tree).toMatchObject({
            adoID: 820001,
            title: "Leaf task",
            assignedTo: "Alice Example",
            type: "Task",
            createdAt: "2026-01-02T03:04:05Z",
            updatedAt: "2026-02-03T04:05:06Z",
        });
    });

    test("returns every child with its own id, title, type and assignee", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 820001 });

        expect(tree?.children).toEqual([
            {
                adoID: 830001,
                title: "First child",
                assignedTo: "Bob Example",
                type: "Task",
                parent: [],
                children: [],
                related: [],
                createdAt: "2026-01-02T03:04:05Z",
                updatedAt: "2026-02-03T04:05:06Z",
            },
            {
                adoID: 830002,
                title: "Second child",
                assignedTo: null,
                type: "Task",
                parent: [],
                children: [],
                related: [],
                createdAt: "2026-01-02T03:04:05Z",
                updatedAt: "2026-02-03T04:05:06Z",
            },
        ]);
    });

    test("returns the related items", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 820001 });

        expect(tree?.related.map((node) => node.adoID)).toEqual([840001]);
    });

    test("climbs the whole parent chain, nearest ancestor first", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 820001 });

        expect(tree?.parent.map((node) => node.adoID)).toEqual([820002, 820003, 820004, 820005]);
    });

    test("link targets carry no neighbours of their own, so the shape cannot loop", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 820001 });

        expect(tree?.parent.every((node) => node.parent.length === 0 && node.children.length === 0)).toBe(true);
    });

    test("rides the neighbours and the first parent in one request", async () => {
        const { batches, fetchMany } = fetcher();

        await buildWorkItemTree({ fetchMany, id: 820001 });

        expect(batches).toEqual([[820001], [830001, 830002, 840001, 820002], [820003], [820004], [820005]]);
    });

    test("asks for each work item exactly once", async () => {
        const { batches, fetchMany } = fetcher();

        await buildWorkItemTree({ fetchMany, id: 820001 });

        const requested = batches.flat();

        expect(requested.length).toBe(new Set(requested).size);
    });

    test("returns null when the work item itself is not returned", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 990001 });

        expect(tree).toBeNull();
    });

    test("stops instead of looping when the parent chain cycles back", async () => {
        const { batches, fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 860001 });

        expect(tree?.parent.map((node) => node.adoID)).toEqual([860002]);
        expect(batches).toEqual([[860001], [860002]]);
    });

    test("stops on a work item that is its own parent", async () => {
        const { batches, fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 860003 });

        expect(tree?.parent).toEqual([]);
        expect(batches).toEqual([[860003]]);
    });

    test("keeps climbing past an ancestor that is also a related item of the root", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 870001 });

        expect(tree?.parent.map((node) => node.adoID)).toEqual([870002, 870003, 870004]);
    });

    test("spends no second request on an ancestor that already arrived as a related item", async () => {
        const { batches, fetchMany } = fetcher();

        await buildWorkItemTree({ fetchMany, id: 870001 });

        expect(batches).toEqual([[870001], [870003, 870002], [870004]]);
    });

    test("leaves out a child the server did not return", async () => {
        const { fetchMany } = fetcher();

        const tree = await buildWorkItemTree({ fetchMany, id: 850001 });

        expect(tree?.children).toEqual([]);
    });
});
