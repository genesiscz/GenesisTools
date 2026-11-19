import { describe, expect, test } from "bun:test";
import { type ChildPr, findOrphanedChildren, parsePrePushLines, type RefUpdate } from "./stack-children-guard";

// A tiny history: old parent P0, rebuilt parent P1, a child C0 on P0, the child C1 rebuilt on P1.
const ancestors: Record<string, string[]> = {
    p0: ["p0"],
    p1: ["p1"],
    c0: ["c0", "p0"],
    c1: ["c1", "p1"],
};
const isAncestor = (a: string, b: string): boolean => (ancestors[b] ?? []).includes(a);
const child: ChildPr = { number: 9, title: "child work", headRefName: "child", headSha: "c0" };
const parentPush: RefUpdate = { localSha: "p1", remoteRef: "refs/heads/parent", remoteSha: "p0" };

describe("findOrphanedChildren", () => {
    test("a rewritten parent with a child that still holds the old head is refused", () => {
        const orphaned = findOrphanedChildren([parentPush], () => [child], isAncestor);
        expect(orphaned.map((o) => o.child.number)).toEqual([9]);
    });

    test("the child pushed in the same command onto the new head passes", () => {
        const childPush: RefUpdate = { localSha: "c1", remoteRef: "refs/heads/child", remoteSha: "c0" };
        expect(findOrphanedChildren([parentPush, childPush], () => [child], isAncestor)).toEqual([]);
    });

    test("a child already rebuilt before the parent push passes, and a fast-forward never asks", () => {
        expect(findOrphanedChildren([parentPush], () => [{ ...child, headSha: "c1" }], isAncestor)).toEqual([]);
        const forward: RefUpdate = { localSha: "c0", remoteRef: "refs/heads/parent", remoteSha: "p0" };
        expect(findOrphanedChildren([forward], () => [child], isAncestor)).toEqual([]);
    });

    test("pre-push lines parse into updates", () => {
        const text = "refs/heads/parent p1 refs/heads/parent p0\nrefs/heads/child c1 refs/heads/child c0\n";
        expect(parsePrePushLines(text).map((u) => u.remoteRef)).toEqual(["refs/heads/parent", "refs/heads/child"]);
    });
});
