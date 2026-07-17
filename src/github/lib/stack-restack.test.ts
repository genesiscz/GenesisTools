import { describe, expect, test } from "bun:test";
import { createNoopStackRestack } from "./stack-restack";

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
