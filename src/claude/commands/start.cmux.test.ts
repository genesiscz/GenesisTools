import { describe, expect, test } from "bun:test";
import { buildLaunchArgs, cmuxPermissionArgs } from "./start";

describe("cmuxPermissionArgs", () => {
    test("injects the bypass because cmux claude-teams execs past the ccc wrapper", () => {
        expect(cmuxPermissionArgs([])).toEqual(["--dangerously-skip-permissions"]);
    });

    test("an explicit permission choice always wins", () => {
        expect(cmuxPermissionArgs(["--dangerously-skip-permissions"])).toEqual([]);
        expect(cmuxPermissionArgs(["--permission-mode", "plan"])).toEqual([]);
        expect(cmuxPermissionArgs(["--permission-mode=plan"])).toEqual([]);
    });

    test("an unrelated flag that merely mentions permissions does not count", () => {
        expect(cmuxPermissionArgs(["--print", "describe --permission-mode"])).toEqual([
            "--dangerously-skip-permissions",
        ]);
    });
});

describe("buildLaunchArgs", () => {
    test("injected permission flag precedes a positional prompt", () => {
        const args = buildLaunchArgs({ resumeArgs: [], passthrough: ["do the thing"], cmux: true });

        expect(args).toEqual(["--dangerously-skip-permissions", "do the thing"]);
    });

    test("injected permission flag precedes a -- separator", () => {
        const args = buildLaunchArgs({ resumeArgs: [], passthrough: ["--", "-p", "hi"], cmux: true });

        expect(args.indexOf("--dangerously-skip-permissions")).toBeLessThan(args.indexOf("--"));
    });

    test("model comes first and forwarded args keep their order", () => {
        const args = buildLaunchArgs({
            modelId: "claude-fable-5",
            resumeArgs: ["--resume", "abc"],
            passthrough: ["-p", "hi"],
            cmux: true,
        });

        expect(args).toEqual([
            "--model",
            "claude-fable-5",
            "--dangerously-skip-permissions",
            "--resume",
            "abc",
            "-p",
            "hi",
        ]);
    });

    test("without --cmux nothing is injected", () => {
        const args = buildLaunchArgs({ resumeArgs: ["--continue"], passthrough: ["-p"], cmux: false });

        expect(args).toEqual(["--continue", "-p"]);
    });
});
