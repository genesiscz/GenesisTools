import { describe, expect, test } from "bun:test";
import { buildClaudeArgv, buildCmuxCommand, shellQuote } from "./claudeLauncher";

describe("cmux claude launcher", () => {
    test("quotes quotes, dollars, backticks and newlines", () => {
        const command = buildCmuxCommand({
            account: "work",
            name: "handoff h_x",
            prompt: "do 'this'\nand $HOME `date`",
            cwd: "/tmp/my repo",
        });

        expect(command.startsWith("cd '/tmp/my repo' && ")).toBe(true);
        expect(command).toContain(shellQuote("do 'this'\nand $HOME `date`"));
        expect(command).not.toContain(" && $HOME");
    });

    test("resume and model stay in front of --, and extra args pass through", () => {
        expect(
            buildClaudeArgv({
                account: "work",
                resume: "abc",
                model: "opus",
                name: "handoff",
                prompt: "go",
                runArgs: ["--dangerously-skip-permissions"],
                claudeArgs: ["--permission-mode", "plan"],
            })
        ).toEqual([
            "tools",
            "claude",
            "run",
            "work",
            "-r",
            "abc",
            "-m",
            "opus",
            "--dangerously-skip-permissions",
            "--",
            "-n",
            "handoff",
            "--permission-mode",
            "plan",
            "go",
        ]);
    });

    test("a prompt over 8kb is refused unless it came from a file", () => {
        expect(() => buildClaudeArgv({ account: "work", prompt: "x".repeat(8193) })).toThrow(/cap/);
        expect(buildClaudeArgv({ account: "work", prompt: "x".repeat(8193), enforceCap: false }).at(-1)).toHaveLength(
            8193
        );
    });

    test("the cap counts UTF-8 bytes, not string length", () => {
        const wide = "é".repeat(4097);

        expect(wide.length).toBeLessThan(8192);
        expect(() => buildClaudeArgv({ account: "work", prompt: wide })).toThrow("prompt is 8194 bytes");
        expect(buildClaudeArgv({ account: "work", prompt: "é".repeat(4096) }).at(-1)).toHaveLength(4096);
    });

    test("a prompt file is read by the command when it runs, and a prompt past the exec limit is refused", () => {
        const command = buildCmuxCommand({
            account: "work",
            prompt: "x".repeat(20_000),
            enforceCap: false,
            promptFile: "/tmp/my prompt.md",
            cwd: "/tmp/repo",
        });

        expect(command.endsWith(`'--' "$(cat '/tmp/my prompt.md')"`)).toBe(true);
        expect(command).not.toContain("x".repeat(100));
        expect(() => buildClaudeArgv({ account: "work", prompt: "x".repeat(600_000), enforceCap: false })).toThrow(
            "exec argument limit"
        );
    });

    test("an empty extra argument keeps its place", () => {
        const argv = buildClaudeArgv({
            account: "work",
            prompt: "go",
            claudeArgs: ["--append-system-prompt", "", "--verbose"],
        });

        expect(argv.slice(-4)).toEqual(["--append-system-prompt", "", "--verbose", "go"]);
    });
});
