import { describe, expect, test } from "bun:test";
import { createNoopStackRestack, gitAuthEnv, pickOldBase, unknownBaseRefusal } from "./stack-restack";

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

describe("unknownBaseRefusal", () => {
    test("refuses a rebase only when the earlier base tips could not be read", () => {
        const input = { branch: "feat", newBase: "main" };

        expect(unknownBaseRefusal({ ...input, priorBaseShas: null })?.message).toContain("Refusing to rebase it");
        expect(unknownBaseRefusal({ ...input, priorBaseShas: [] })).toBeNull();
        expect(unknownBaseRefusal({ ...input, priorBaseShas: ["old-tip"] })).toBeNull();
        expect(unknownBaseRefusal(input)).toBeNull();
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

describe("gitAuthEnv", () => {
    test("carries the token as an extraheader in the environment, never in a URL", () => {
        const auth = gitAuthEnv("tok-123");
        expect(auth?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
        const header = auth?.GIT_CONFIG_VALUE_0 ?? "";
        expect(Buffer.from(header.replace("AUTHORIZATION: basic ", ""), "base64").toString()).toBe(
            "x-access-token:tok-123"
        );
        expect(gitAuthEnv(undefined)).toBeUndefined();
    });
});
