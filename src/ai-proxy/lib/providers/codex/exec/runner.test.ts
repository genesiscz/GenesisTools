import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOOKS_CONFIG } from "@app/agents/lib/hooks/config";
import {
    guardedExecCommand,
    runShellCommand,
    truncateMiddle,
} from "@app/ai-proxy/lib/providers/codex/exec/exec-command";
import { shellGuard } from "@app/ai-proxy/lib/providers/codex/exec/guard";
import { EXEC_OUTPUT_CHARS, parseExecPragma, runExecScript } from "@app/ai-proxy/lib/providers/codex/exec/script";
import { fileExecStore, memoryExecStore } from "@app/ai-proxy/lib/providers/codex/exec/store";
import type { ExecCommandArgs, ExecCommandResult } from "@app/ai-proxy/lib/providers/codex/exec/types";
import type { ShellRule } from "@genesiscz/utils/shell/rules/types";

/** The shipped hooks config with the guard live: shipped, it runs in shadow mode and only logs. */
const LIVE_CONFIG = { ...DEFAULT_HOOKS_CONFIG, shadow: false };

/** A clock that reads 0, then 1500 ms: every script reports "Wall time 1.5 seconds". */
function fixedClock(): () => number {
    let calls = 0;
    return () => (calls++ === 0 ? 0 : 1500);
}

function fakeCommand(answer: Partial<ExecCommandResult> = {}): {
    run: (args: ExecCommandArgs) => Promise<ExecCommandResult>;
    calls: ExecCommandArgs[];
} {
    const calls: ExecCommandArgs[] = [];

    return {
        calls,
        run: async (args) => {
            calls.push(args);
            return { output: `ran ${args.cmd}`, exit_code: 0, wall_time_seconds: 0.1, ...answer };
        },
    };
}

async function run(source: string, execCommand = fakeCommand().run, store = memoryExecStore()): Promise<string> {
    return runExecScript({ source, execCommand, store, now: fixedClock() });
}

describe("the exec runner's script", () => {
    it("prints Codex's header, then each text item on its own line", async () => {
        const output = await run('text("one");\ntext(2);\ntext({ a: 1 });\ntext(undefined);\n');

        expect(output).toBe('Script completed\nWall time 1.5 seconds\nOutput:\none\n2\n{"a":1}\nundefined');
    });

    it("reads the first-line pragma: max_output_tokens caps the output, yield_time_ms is accepted", async () => {
        expect(parseExecPragma('// @exec: {"yield_time_ms": 10000, "max_output_tokens": 25}\ntext(1)')).toEqual({
            maxOutputTokens: 25,
            yieldTimeMs: 10000,
        });
        expect(parseExecPragma("text(1)")).toEqual({});
        expect(parseExecPragma("// @exec: not json\ntext(1)")).toEqual({});

        const output = await run(`// @exec: {"max_output_tokens": 25}\ntext("${"a".repeat(400)}");\n`);
        const body = output.slice(output.indexOf("Output:\n") + "Output:\n".length);

        expect(output.startsWith("Script completed\nWall time 1.5 seconds\nOutput:\n")).toBe(true);
        expect(body.length).toBeLessThanOrEqual(25 * 4);
        expect(body).toContain("chars truncated");
    });

    it("exit() ends the script successfully, and the text before it stays", async () => {
        const output = await run('text("before");\nexit();\ntext("after");\n');

        expect(output).toBe("Script completed\nWall time 1.5 seconds\nOutput:\nbefore");
    });

    it("an uncaught error fails the script with Codex's Script error item after the text so far", async () => {
        const output = await run('text("partial");\nthrow new Error("boom");\n');

        expect(output).toBe("Script failed\nWall time 1.5 seconds\nOutput:\npartial\nScript error:\nboom");
    });

    it("handles synchronous and asynchronous timer failures and exit", async () => {
        for (const callback of ['throw new Error("boom")', 'return Promise.reject(new Error("boom"))']) {
            const output = await run(`await new Promise(() => setTimeout(() => { ${callback}; }, 0));`);
            expect(output).toContain("Script failed");
            expect(output).toContain("Script error:\nboom");
        }

        expect(await run("await new Promise(() => setTimeout(() => exit(), 0));")).toContain("Script completed");
    });

    it("a syntax error fails the script and names the error", async () => {
        const output = await run("const = ;");

        expect(output.startsWith("Script failed\nWall time 1.5 seconds\nOutput:\nScript error:\n")).toBe(true);
    });

    it("hides Node, Bun, console and fetch from the script, as Codex's isolate does", async () => {
        const output = await run(
            "text([typeof process, typeof Bun, typeof require, typeof console, typeof fetch].join(','));"
        );

        expect(output.endsWith("Output:\nundefined,undefined,undefined,undefined,undefined")).toBe(true);
    });

    it("tools.exec_command takes an object or a string and returns the command's result", async () => {
        const command = fakeCommand({ exit_code: 3 });
        const output = await run(
            'const a = await tools.exec_command({ cmd: "echo a", workdir: "/w" });\nconst b = await tools.exec_command("echo b");\ntext(a.output + "|" + a.exit_code + "|" + b.output);\ntext(ALL_TOOLS.map((t) => t.name));',
            command.run
        );

        expect(command.calls).toEqual([{ cmd: "echo a", workdir: "/w" }, { cmd: "echo b" }]);
        expect(output.endsWith('Output:\nran echo a|3|ran echo b\n["exec_command"]')).toBe(true);
    });

    it("store and load keep a value for later scripts of the same session only", async () => {
        const dir = mkdtempSync(join(tmpdir(), "exec-store-"));
        const store = fileExecStore(join(dir, "session-a.json"));

        await run('store("plan", { step: 2, files: ["a.ts"] });', undefined, store);
        const again = await run('text(load("plan"));\ntext(load("missing"));', undefined, store);
        const other = await run('text(load("plan"));', undefined, fileExecStore(join(dir, "session-b.json")));

        expect(again.endsWith('Output:\n{"step":2,"files":["a.ts"]}\nundefined')).toBe(true);
        expect(other.endsWith("Output:\nundefined")).toBe(true);
    });

    it(`keeps the whole output under Claude Code's 30,000-char Bash limit (${EXEC_OUTPUT_CHARS} chars of body)`, async () => {
        const output = await run('text("x".repeat(100000));\ntext("tail");');

        expect(EXEC_OUTPUT_CHARS).toBeLessThan(30_000);
        expect(output.length).toBeLessThan(30_000);
        expect(output.startsWith("Script completed\nWall time 1.5 seconds\nOutput:\n")).toBe(true);
        expect(output.endsWith("tail")).toBe(true);
        expect(output).toContain("chars truncated");
    });
});

describe("the exec runner's commands", () => {
    it("runs a command in its workdir, with stdout and stderr in one output and the exit code", async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-cmd-")));
        const result = await runShellCommand(
            { cmd: "pwd; printf 'to-err' >&2; exit 3", workdir: dir, shell: "/bin/sh" },
            { cwd: "/" }
        );

        expect(result.exit_code).toBe(3);
        expect(result.output).toContain(dir);
        expect(result.output).toContain("to-err");
        expect(typeof result.wall_time_seconds).toBe("number");
    });

    it("cuts a long output in the middle to max_output_tokens and reports the original size", () => {
        expect(truncateMiddle("short", 100)).toEqual({ text: "short", truncated: false });
        for (const budget of [0, 1, 4, 10]) {
            expect(truncateMiddle("x".repeat(100), budget).text.length).toBeLessThanOrEqual(budget);
        }

        const cut = truncateMiddle(`HEAD${"m".repeat(1000)}TAIL`, 100);

        expect(cut.truncated).toBe(true);
        expect(cut.text.length).toBeLessThanOrEqual(100);
        expect(cut.text.startsWith("HEAD")).toBe(true);
        expect(cut.text.endsWith("TAIL")).toBe(true);
    });

    it("drains large output within the budget and reports the original count", async () => {
        const result = await runShellCommand(
            { cmd: "printf HEAD; printf '%0100000d' 0; printf TAIL", shell: "/bin/sh", max_output_tokens: 25 },
            { cwd: "/tmp" }
        );
        expect(result.exit_code).toBe(0);
        expect(result.output.length).toBeLessThanOrEqual(100);
        expect(result.output.startsWith("HEAD")).toBe(true);
        expect(result.output.endsWith("TAIL")).toBe(true);
        expect(result.original_token_count).toBe(25002);
    });

    it("times out a background child holding pipes and prevents its later side effect", async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-timeout-")));
        const started = performance.now();
        await expect(
            runShellCommand(
                { cmd: "(sleep 0.5; printf child > marker) &", shell: "/bin/sh" },
                { cwd: dir, deadlineAt: performance.now() + 150 }
            )
        ).rejects.toThrow("script deadline expired");
        expect(performance.now() - started).toBeLessThan(1500);
        await Bun.sleep(600);
        expect(existsSync(join(dir, "marker"))).toBe(false);
        await expect(
            runShellCommand(
                { cmd: "printf late > marker", shell: "/bin/sh" },
                { cwd: dir, deadlineAt: performance.now() - 1 }
            )
        ).rejects.toThrow("before the command started");
        expect(existsSync(join(dir, "marker"))).toBe(false);

        const normal = await runShellCommand({ cmd: "printf normal", shell: "/bin/sh" }, { cwd: dir });
        expect(normal.output).toBe("normal");
        expect(normal.exit_code).toBe(0);
    });

    it("the shell guard blocks a nested command before it runs, and the script sees the deny as an error", async () => {
        const inner = fakeCommand();
        const guard = await shellGuard({ config: LIVE_CONFIG });
        const execCommand = guardedExecCommand({ guard, cwd: "/tmp", run: inner.run });

        const caught = await run(
            'try { await tools.exec_command({ cmd: "git checkout -- a.ts" }); } catch (error) { text("caught: " + error.message); }\nconst ok = await tools.exec_command({ cmd: "git status --short" });\ntext(ok.output);',
            execCommand
        );

        expect(inner.calls.map((call) => call.cmd)).toEqual(["git status --short"]);
        expect(caught).toContain("caught: exec_command failed: the shell guard blocked this command");
        expect(caught).toContain("git-checkout-overwrites-file");
        expect(caught.endsWith("ran git status --short")).toBe(true);

        const uncaught = await run('await tools.exec_command({ cmd: "git checkout -- a.ts" });', execCommand);

        expect(
            uncaught.startsWith("Script failed\nWall time 1.5 seconds\nOutput:\nScript error:\nexec_command failed")
        ).toBe(true);
        expect(inner.calls).toHaveLength(1);
    });

    it("applies model-specific guard outcomes and fails closed without a model", async () => {
        const config = {
            ...LIVE_CONFIG,
            guard: {
                ...LIVE_CONFIG.guard,
                models: {
                    "test-deny": { "git-checkout-overwrites-file": "block" as const },
                    "test-allow": { "git-checkout-overwrites-file": "allow" as const },
                },
            },
        };
        const denied = await shellGuard({ config, model: "test-deny" });
        const allowed = await shellGuard({ config, model: "test-allow" });
        expect(denied.check("git checkout -- a.ts", "/tmp").outcome).toBe("block");
        expect(allowed.check("git checkout -- a.ts", "/tmp").outcome).toBe("allow");
        expect(shellGuard({ config })).rejects.toThrow("requires the session model");
    });

    it("in shadow mode the guard only watches, as the hook does: the command runs", async () => {
        const inner = fakeCommand();
        const guard = await shellGuard({ config: { ...DEFAULT_HOOKS_CONFIG, shadow: true } });
        await run(
            'await tools.exec_command({ cmd: "git checkout -- a.ts" });',
            guardedExecCommand({ guard, cwd: "/tmp", run: inner.run })
        );

        expect(inner.calls).toHaveLength(1);
    });

    it("a guard warning runs the command and rides along in guard_warning", async () => {
        const warnRule: ShellRule = {
            id: "test-warn-echo",
            kind: "misread",
            title: "echo is a test warning",
            severity: "warn",
            why: "a test",
            wrong: "echo",
            right: "printf",
            detect: (scan) => (scan.command.startsWith("echo") ? { matched: "echo", index: 0 } : null),
        };
        const inner = fakeCommand();
        const guard = await shellGuard({ config: LIVE_CONFIG, rules: [warnRule] });
        const execCommand = guardedExecCommand({ guard, cwd: "/tmp", run: inner.run });
        const output = await run(
            'const r = await tools.exec_command("echo hi");\ntext(r.guard_warning ?? "none");',
            execCommand
        );

        expect(inner.calls).toHaveLength(1);
        expect(output).toContain("test-warn-echo");
    });
});

describe("the exec runner entry", () => {
    it("reads the script from stdin in any folder and prints the result with exit code 0", async () => {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-entry-")));
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "runner.ts"), "--session", "entry-test"], {
            cwd: dir,
            env: process.env,
            stdin: new TextEncoder().encode(
                'const r = await tools.exec_command({ cmd: "pwd" });\ntext(r.output.trim() + " " + r.exit_code);\n'
            ),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\n/);
        expect(stdout.endsWith(`${dir} 0`)).toBe(true);
    });

    it("flushes the full output before exiting when stdout is consumed later", async () => {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "runner.ts")], {
            env: process.env,
            stdin: new TextEncoder().encode(`text("x".repeat(${EXEC_OUTPUT_CHARS}));`),
            stdout: "pipe",
            stderr: "pipe",
        });
        await Bun.sleep(100);
        const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
        expect(code).toBe(0);
        expect(stdout.endsWith("x".repeat(EXEC_OUTPUT_CHARS))).toBe(true);
    });

    it("writes its log lines to the day log only, never to stderr, so Codex's header stays the first line the model reads", async () => {
        // The live run of 2026-10-29 put "ai-proxy exec: the shell guard blocked a nested command" above the header,
        // because Claude Code's Bash result carries stderr too. A console level makes the runner's own logs visible.
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "exec-entry-")));
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, "runner.ts")], {
            cwd: dir,
            env: { ...process.env, LOG_CONSOLE_LEVEL: "debug", LOG_SILENT: "" },
            stdin: new TextEncoder().encode('text("done");\n'),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toMatch(/^Script completed\nWall time \d+\.\d seconds\nOutput:\ndone$/);
    });
});
