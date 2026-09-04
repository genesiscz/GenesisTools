import { describe, expect, test } from "bun:test";
import { resumeArgv, resumeCommandLine } from "./resume-argv";

const GROK_ID = "01a05cc5-0ecf-7d40-945e-977e45b3f935";
const CLAUDE_ID = "6bdfb457-cee9-4202-8105-21be8a801757";
const CODEX_ID = "01a067d4-d2b0-7532-8f59-9af2a29c2d0e";

describe("resumeArgv", () => {
    test("grok uses -r <id>", () => {
        expect(resumeArgv("grok", GROK_ID)).toEqual(["grok", "-r", GROK_ID]);
    });

    test("codex uses resume <id>", () => {
        expect(resumeArgv("codex", CODEX_ID)).toEqual(["codex", "resume", CODEX_ID]);
    });

    test("claude without an account uses the bare binary", () => {
        expect(resumeArgv("claude", CLAUDE_ID)).toEqual(["claude", "--resume", CLAUDE_ID]);
    });

    test("claude with an account goes through tools claude start", () => {
        expect(resumeArgv("claude", CLAUDE_ID, "work")).toEqual([
            "tools",
            "claude",
            "start",
            "work",
            "--",
            "--resume",
            CLAUDE_ID,
        ]);
    });
});

describe("resumeCommandLine", () => {
    test("joins grok -r without extra quotes on a uuid", () => {
        expect(resumeCommandLine("grok", GROK_ID)).toBe(`grok -r ${GROK_ID}`);
    });
});
