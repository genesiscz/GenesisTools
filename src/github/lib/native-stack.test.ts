import { describe, expect, test } from "bun:test";
import {
    formatNativeStackRecovery,
    isNativeStackBaseError,
    NATIVE_STACK_BASE_ERROR,
    parsePullStackNumber,
    posixShellSingleQuote,
} from "./native-stack";

describe("isNativeStackBaseError", () => {
    test("matches the exact GitHub 422 errors[].message", () => {
        expect(isNativeStackBaseError(new Error(NATIVE_STACK_BASE_ERROR))).toBe(true);
    });

    test("matches the octokit Validation Failed wrapper from the 2026-08-20 incident", () => {
        const wrapped = new Error(
            `Validation Failed: {"message":"${NATIVE_STACK_BASE_ERROR}","resource":"PullRequest","field":"base","code":"invalid"}`
        );
        expect(isNativeStackBaseError(wrapped)).toBe(true);
    });

    test("matches octokit RequestError response.errors[]", () => {
        const err = Object.assign(new Error("Validation Failed"), {
            status: 422,
            response: {
                data: {
                    message: "Validation Failed",
                    errors: [
                        {
                            message: NATIVE_STACK_BASE_ERROR,
                            resource: "PullRequest",
                            field: "base",
                            code: "invalid",
                        },
                    ],
                },
            },
        });
        expect(isNativeStackBaseError(err)).toBe(true);
    });

    test("rejects unrelated retarget failures", () => {
        expect(isNativeStackBaseError(new Error("API error retargeting #3"))).toBe(false);
        expect(isNativeStackBaseError(new Error("Validation Failed"))).toBe(false);
        expect(isNativeStackBaseError(null)).toBe(false);
    });
});

describe("parsePullStackNumber", () => {
    test("reads stack.number from the live pulls.get shape", () => {
        expect(
            parsePullStackNumber({
                number: 7,
                stack: {
                    base: { ref: "master", sha: "43fe2ec59d733a8f4392cb74ba54f690fd01317d" },
                    id: 237241,
                    number: 8,
                    position: 2,
                    size: 2,
                },
            })
        ).toBe(8);
    });

    test("returns null when the PR is not in a stack", () => {
        expect(parsePullStackNumber({ number: 10, stack: null })).toBe(null);
        expect(parsePullStackNumber({})).toBe(null);
        expect(parsePullStackNumber(null)).toBe(null);
    });
});

describe("formatNativeStackRecovery", () => {
    test("emits unstack then PATCH, and forbids close-and-reopen", () => {
        const lines = formatNativeStackRecovery({
            owner: "genesiscz",
            repo: "Notes",
            parentNumber: 6,
            childNumber: 7,
            newBase: "master",
            stackNumber: 8,
        });
        expect(lines.some((l) => l.includes("still OPEN"))).toBe(true);
        expect(lines.some((l) => l.includes("Do not close and reopen"))).toBe(true);
        expect(lines).toContain("gh api -X POST repos/genesiscz/Notes/stacks/8/unstack");
        expect(lines).toContain("gh api -X PATCH repos/genesiscz/Notes/pulls/7 -f base='master'");
        expect(lines.join("\n")).toContain(NATIVE_STACK_BASE_ERROR);
    });

    test("quotes a branch name that contains a single quote", () => {
        const lines = formatNativeStackRecovery({
            owner: "o",
            repo: "r",
            parentNumber: 1,
            childNumber: 2,
            newBase: "feat/it's-fine",
            stackNumber: 3,
        });
        expect(lines).toContain("gh api -X PATCH repos/o/r/pulls/2 -f base='feat/it'\\''s-fine'");
    });
});

describe("posixShellSingleQuote", () => {
    test("wraps plain names and escapes embedded quotes", () => {
        expect(posixShellSingleQuote("master")).toBe("'master'");
        expect(posixShellSingleQuote("feat/it's-fine")).toBe("'feat/it'\\''s-fine'");
    });
});
