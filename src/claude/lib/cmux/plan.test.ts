import { describe, expect, test } from "bun:test";
import { buildGridTree, buildRestorePlan, gridShape, readingOrderCells } from "@app/claude/lib/cmux/plan";
import type { RestoreCandidate } from "@app/claude/lib/cmux/types";
import type { SplitTree } from "@genesiscz/utils/cmux/split-tree";

function candidate(overrides: Partial<RestoreCandidate> & { sessionId: string }): RestoreCandidate {
    return {
        cwd: `/Users/me/Projects/${overrides.project ?? "app"}`,
        project: "app",
        branch: null,
        title: null,
        lastPrompt: null,
        limitStop: null,
        subdir: null,
        mtimeMs: 0,
        account: null,
        model: null,
        pinned: false,
        ...overrides,
    };
}

const OPTS = { layout: "capped" as const, perWorkspace: 4, perProject: true };

function leafIndices(tree: SplitTree): number[] {
    if (tree.kind === "leaf") {
        return [tree.paneIndex];
    }

    return tree.kind === "vsplit"
        ? [...leafIndices(tree.left), ...leafIndices(tree.right)]
        : [...leafIndices(tree.top), ...leafIndices(tree.bottom)];
}

describe("gridShape", () => {
    test("is as square as possible, extra rows on the left", () => {
        expect(gridShape(1)).toEqual([1]);
        expect(gridShape(2)).toEqual([1, 1]);
        expect(gridShape(3)).toEqual([2, 1]);
        expect(gridShape(4)).toEqual([2, 2]);
        expect(gridShape(5)).toEqual([2, 2, 1]);
        expect(gridShape(7)).toEqual([3, 2, 2]);
        expect(gridShape(9)).toEqual([3, 3, 3]);
    });

    test("every pane is placed exactly once", () => {
        for (let n = 1; n <= 24; n += 1) {
            expect(gridShape(n).reduce((a, b) => a + b, 0)).toBe(n);
        }
    });
});

describe("readingOrderCells", () => {
    test("walks left to right, top row first, skipping short columns", () => {
        expect(readingOrderCells([2, 1])).toEqual([
            [0, 0],
            [1, 0],
            [0, 1],
        ]);
    });
});

describe("buildGridTree", () => {
    test("a single pane is a bare leaf", () => {
        expect(buildGridTree(1)).toEqual({ kind: "leaf", paneIndex: 0 });
    });

    test("two panes split side by side down the middle", () => {
        expect(buildGridTree(2)).toEqual({
            kind: "vsplit",
            left: { kind: "leaf", paneIndex: 0 },
            right: { kind: "leaf", paneIndex: 1 },
            leftFraction: 0.5,
        });
    });

    test("three columns each take a third, then a half of the remainder", () => {
        const tree = buildGridTree(6);

        expect(tree.kind).toBe("vsplit");

        if (tree.kind === "vsplit") {
            expect(tree.leftFraction).toBeCloseTo(1 / 3);
            expect(tree.right.kind === "vsplit" && tree.right.leftFraction).toBeCloseTo(0.5);
        }
    });

    test("pane indices cover 0..n-1 exactly once", () => {
        for (let n = 1; n <= 16; n += 1) {
            expect(leafIndices(buildGridTree(n)).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
        }
    });

    test("index 1 sits in the second column, not below index 0", () => {
        const tree = buildGridTree(4);

        // 2x2 grid: reading order means the right-hand column holds 1 and 3.
        expect(tree.kind).toBe("vsplit");

        if (tree.kind === "vsplit") {
            expect(leafIndices(tree.left)).toEqual([0, 2]);
            expect(leafIndices(tree.right)).toEqual([1, 3]);
        }
    });
});

describe("buildRestorePlan", () => {
    test("no sessions means no workspaces", () => {
        expect(buildRestorePlan([], OPTS)).toEqual({ workspaces: [] });
    });

    test("one workspace per project, in first-seen order", () => {
        const plan = buildRestorePlan(
            [
                candidate({ sessionId: "a", project: "alpha" }),
                candidate({ sessionId: "b", project: "beta" }),
                candidate({ sessionId: "c", project: "alpha" }),
            ],
            OPTS
        );

        expect(plan.workspaces.map((w) => w.title)).toEqual(["alpha", "beta"]);
        expect(plan.workspaces[0].panes.map((p) => p.sessions[0].candidate.sessionId)).toEqual(["a", "c"]);
    });

    test("overflows past the cap into numbered sibling workspaces", () => {
        const plan = buildRestorePlan(
            Array.from({ length: 6 }, (_, i) => candidate({ sessionId: `s${i}`, project: "alpha" })),
            { ...OPTS, perWorkspace: 4 }
        );

        expect(plan.workspaces.map((w) => w.title)).toEqual(["alpha 1", "alpha 2"]);
        expect(plan.workspaces[0].panes).toHaveLength(4);
        expect(plan.workspaces[1].panes).toHaveLength(2);
    });

    test("grid layout ignores the cap and keeps one workspace", () => {
        const plan = buildRestorePlan(
            Array.from({ length: 6 }, (_, i) => candidate({ sessionId: `s${i}`, project: "alpha" })),
            { ...OPTS, layout: "grid" }
        );

        expect(plan.workspaces).toHaveLength(1);
        expect(plan.workspaces[0].panes).toHaveLength(6);
    });

    test("tabs layout stacks the overflow into the existing panes", () => {
        const plan = buildRestorePlan(
            Array.from({ length: 6 }, (_, i) => candidate({ sessionId: `s${i}`, project: "alpha" })),
            { ...OPTS, layout: "tabs", perWorkspace: 4 }
        );

        expect(plan.workspaces).toHaveLength(1);
        expect(plan.workspaces[0].panes).toHaveLength(4);
        expect(plan.workspaces[0].panes[0].sessions.map((s) => s.candidate.sessionId)).toEqual(["s0", "s4"]);
        expect(plan.workspaces[0].panes[3].sessions.map((s) => s.candidate.sessionId)).toEqual(["s3"]);
    });

    test("without per-project every session lands in one titled set", () => {
        const plan = buildRestorePlan(
            [candidate({ sessionId: "a", project: "alpha" }), candidate({ sessionId: "b", project: "beta" })],
            { ...OPTS, perProject: false }
        );

        expect(plan.workspaces).toHaveLength(1);
        expect(plan.workspaces[0].title).toBe("claude");
    });

    test("the recorded pin becomes the pane's account, and --account overrides it", () => {
        const sessions = [candidate({ sessionId: "a", account: "max-primary", model: "opus" })];

        expect(buildRestorePlan(sessions, OPTS).workspaces[0].panes[0].sessions[0].account).toBe("max-primary");
        expect(
            buildRestorePlan(sessions, { ...OPTS, forceAccount: "work" }).workspaces[0].panes[0].sessions[0]
        ).toMatchObject({ account: "work", model: "opus" });
    });
});
