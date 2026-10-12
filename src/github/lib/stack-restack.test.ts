import { describe, expect, test } from "bun:test";
import { createNoopStackRestack, pickOldBase } from "./stack-restack";

describe("pickOldBase", () => {
    const inHistory = (shas: string[]) => async (sha: string) => shas.includes(sha);

    test("keeps the parent tip at merge time when the branch carries it", async () => {
        expect(await pickOldBase(["new-tip", "old-tip"], inHistory(["new-tip", "old-tip"]))).toBe("new-tip");
    });

    test("finds the earlier base tip a branch sits on after its parent was restacked", async () => {
        expect(await pickOldBase(["new-tip", "old-tip", "older-tip"], inHistory(["old-tip", "older-tip"]))).toBe(
            "old-tip"
        );
    });

    test("is null when the branch carries none of them", async () => {
        expect(await pickOldBase(["new-tip", "old-tip"], inHistory([]))).toBeNull();
        expect(await pickOldBase([], inHistory(["x"]))).toBeNull();
    });
});

describe("createNoopStackRestack", () => {
    test("returns expected head unchanged", async () => {
        const restack = createNoopStackRestack();
        const result = await restack.restackBranch({
            owner: "o",
            repo: "r",
            branch: "feat",
            expectedHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            newBase: "main",
            oldBaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
        expect(result).toEqual({
            headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            rebased: false,
            alreadyLinear: true,
        });
    });
});
