import { describe, expect, test } from "bun:test";
import { CMUX_LAUNCH_URL, presetById } from "@genesiscz/utils/browser-router/presets";
import { defaultRouterConfig, parseConfig, route } from "@genesiscz/utils/browser-router/route";
import { Command } from "commander";
import { assertLauncherExists, registerLaunchCommand } from "../../commands/launch";
import { buildClaudeArgv, buildCmuxCommand, shellQuote } from "./claudeLauncher";

describe("cmux launch agents", () => {
    test("an agent without a launcher names the file that would add it; claude and no agent pass", () => {
        expect(() => assertLauncherExists("codex")).toThrow("add src/cmux/lib/launchers/codexLauncher.ts");
        expect(() => assertLauncherExists("claude")).not.toThrow();
        expect(() => assertLauncherExists(undefined)).not.toThrow();
        expect(() => assertLauncherExists("")).not.toThrow();
    });
});

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

/**
 * The argv the router builds for a cmux launch link, parsed by the real `launch` registration under a
 * root that owns `-v, --verbose` (as `tools cmux` does). The action never runs: the hook stops it.
 */
async function parseRoutedLaunch(url: string): Promise<Record<string, unknown>> {
    const preset = presetById("cmux-claude", () => true);
    const decision = route(
        url,
        parseConfig({ ...defaultRouterConfig(), routes: preset?.routes ?? [] }),
        true,
        false,
        true
    );

    if (decision.kind !== "run") {
        throw new Error(`expected a run, got ${decision.kind}`);
    }

    const program = new Command().exitOverride().option("-v, --verbose").option("--readme");
    registerLaunchCommand(program);
    let parsed: Record<string, unknown> = {};
    const stop = new Error("stop before the action");
    program.hook("preAction", (_root, action) => {
        parsed = action.opts();
        throw stop;
    });
    for (const command of program.commands) {
        command.exitOverride();
    }

    await expect(program.parseAsync(decision.argv.slice(2), { from: "user" })).rejects.toBe(stop);
    return parsed;
}

describe("a routed cmux launch link", () => {
    test("extra claude and run arguments that look like the root's own flags reach launch", async () => {
        const params = new URLSearchParams({ prompt: "go", name: "handoff x" });
        params.append("arg", "--verbose");
        params.append("arg", "-v");
        params.append("run", "--readme");
        const opts = await parseRoutedLaunch(`${CMUX_LAUNCH_URL}?${params}`);

        expect(opts.claudeArg).toEqual(["--verbose", "-v"]);
        expect(opts.runArg).toEqual(["--readme"]);
        expect(opts.prompt).toBe("go");
        expect(opts.name).toBe("handoff x");
    });
});
