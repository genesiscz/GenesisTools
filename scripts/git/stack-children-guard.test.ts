import { describe, expect, test } from "bun:test";
import {
    type ChildPr,
    type CommitGraph,
    findOrphanedChildren,
    parsePrePushLines,
    parsePrList,
    type RefUpdate,
} from "./stack-children-guard";

// A tiny history: old parent P0, rebuilt parent P1, a child C0 on P0, the child C1 rebuilt on P1.
// A second stack on master commit M: Q0, then Q1 (the old remote head), rebuilt as Q2 on M; child D0 was cut from Q0,
// and DM is a child on M alone.
const ancestors: Record<string, string[]> = {
    p0: ["p0"],
    p1: ["p1"],
    c0: ["c0", "p0"],
    c1: ["c1", "p1"],
    m: ["m"],
    q0: ["q0", "m"],
    q1: ["q1", "q0", "m"],
    q2: ["q2", "m"],
    d0: ["d0", "q0", "m"],
    dm: ["dm", "m"],
};
const isAncestor = (a: string, b: string): boolean => (ancestors[b] ?? []).includes(a);
const isAncestorOf = (a: string, b: string): boolean => a !== b && isAncestor(a, b);
const graph: CommitGraph = {
    isAncestor,
    mergeBases: (a, b) => {
        const common = (ancestors[a] ?? []).filter((x) => isAncestor(x, b));
        return common.filter((x) => !common.some((y) => isAncestorOf(x, y)));
    },
};
const child: ChildPr = { number: 9, title: "child work", headRefName: "child", headSha: "c0" };
const parentPush: RefUpdate = { localSha: "p1", remoteRef: "refs/heads/parent", remoteSha: "p0" };

describe("findOrphanedChildren", () => {
    test("a rewritten parent with a child that still holds the old head is refused", () => {
        const orphaned = findOrphanedChildren([parentPush], () => [child], graph);
        expect(orphaned.map((o) => o.child.number)).toEqual([9]);
    });

    test("the child pushed in the same command onto the new head passes", () => {
        const childPush: RefUpdate = { localSha: "c1", remoteRef: "refs/heads/child", remoteSha: "c0" };
        expect(findOrphanedChildren([parentPush, childPush], () => [child], graph)).toEqual([]);
    });

    test("a child already rebuilt before the parent push passes, and a fast-forward never asks", () => {
        expect(findOrphanedChildren([parentPush], () => [{ ...child, headSha: "c1" }], graph)).toEqual([]);
        const forward: RefUpdate = { localSha: "c0", remoteRef: "refs/heads/parent", remoteSha: "p0" };
        expect(findOrphanedChildren([forward], () => [child], graph)).toEqual([]);
    });

    test("a child cut from an older parent commit is refused, and a child on master alone passes", () => {
        const rebuilt: RefUpdate = { localSha: "q2", remoteRef: "refs/heads/parent", remoteSha: "q1" };
        const older: ChildPr = { ...child, headSha: "d0" };
        expect(findOrphanedChildren([rebuilt], () => [older], graph).map((o) => o.child.number)).toEqual([9]);
        expect(findOrphanedChildren([rebuilt], () => [{ ...child, headSha: "dm" }], graph)).toEqual([]);
    });

    test("pre-push lines parse into updates", () => {
        const text = "refs/heads/parent p1 refs/heads/parent p0\nrefs/heads/child c1 refs/heads/child c0\n";
        expect(parsePrePushLines(text).map((u) => u.remoteRef)).toEqual(["refs/heads/parent", "refs/heads/child"]);
    });
});

describe("parsePrList", () => {
    test("a gh PR list maps headRefOid to the child head", () => {
        const text = '[{"number":9,"title":"child work","headRefName":"child","headRefOid":"c0"}]';
        expect(parsePrList(text)).toEqual([child]);
    });

    test("an answer that is not a PR list is null, so the guard warns instead of throwing", () => {
        expect(parsePrList("not json")).toBeNull();
        expect(parsePrList('{"message":"rate limited"}')).toBeNull();
        expect(parsePrList('[{"number":"9"}]')).toBeNull();
    });
});
