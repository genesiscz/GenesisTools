import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DEFAULT_HOOKS_CONFIG } from "@app/agents/lib/hooks/config";
import { evaluateCommand } from "@app/agents/lib/hooks/guard";
import {
    delimiterFor,
    EXEC_BASH_TIMEOUT_MS,
    execBashInput,
    execDelimiter,
    parseExecBashCommand,
} from "@app/ai-proxy/lib/providers/codex/exec/bash-command";
import { EXEC_RUNNER_PATH, execToolBridge, execToolDefinition } from "@app/ai-proxy/lib/providers/codex/exec/tool";
import { SHELL_RULES } from "@genesiscz/utils/shell/rules";

const BUN = "/opt/bun/bin/bun";
const WORKTREE_RUNNER = "/tmp/cc/wt/feature/src/ai-proxy/lib/providers/codex/exec/runner.ts";
const MAIN_RUNNER = "/Users/someone/Projects/GenesisTools/src/ai-proxy/lib/providers/codex/exec/runner.ts";

/** Script bodies that a heredoc or a shell could mangle. */
const TRICKY_SCRIPTS = [
    'text("plain");',
    "const s = 'single' + \"double\" + `back ${1 + 1}` + '$HOME' + '\\\\n' + '$(date)';\ntext(s);",
    "const block = `\nEOF\nGT_EXEC_00000000\n`;\ntext(block);",
    "\n\nconst trailing = 1;\ntext(trailing);\n",
    'text("crlf");\r\ntext("still");\r\n',
    '// @exec: {"max_output_tokens": 500}\ntext("with pragma");',
];

describe("exec's Bash command", () => {
    it("pipes the script to the runner through a quoted heredoc named by the script's hash, in Claude Code's Bash input", () => {
        const js = 'const r = await tools.exec_command({ cmd: "ls" });\ntext(r.output);';
        const hash = createHash("sha256").update(js).digest("hex").slice(0, 8);
        const input = execBashInput({ js, bun: BUN, runner: WORKTREE_RUNNER, sessionId: "sess-1" });

        expect(input).toEqual({
            command: `'${BUN}' '${WORKTREE_RUNNER}' --session 'sess-1' <<'GT_EXEC_${hash}'\n${js}\nGT_EXEC_${hash}`,
            description: 'exec: const r = await tools.exec_command({ cmd: "ls" });',
            timeout: EXEC_BASH_TIMEOUT_MS,
        });
        expect(EXEC_BASH_TIMEOUT_MS).toBe(600_000);
    });

    it("gives back each script byte for byte, from any runner path", () => {
        for (const js of TRICKY_SCRIPTS) {
            for (const runner of [WORKTREE_RUNNER, MAIN_RUNNER]) {
                const { command } = execBashInput({ js, bun: BUN, runner, sessionId: "sess-1" });

                expect(parseExecBashCommand(command)).toBe(js);
            }
        }
    });

    it("takes a longer hash when the script holds the short delimiter as a line", () => {
        const hash = "abcdef0123456789".repeat(4);

        expect(delimiterFor("text(1)", hash)).toBe("GT_EXEC_abcdef01");
        expect(delimiterFor("x\nGT_EXEC_abcdef01\ny", hash)).toBe("GT_EXEC_abcdef0123456789");
        expect(delimiterFor("x\nGT_EXEC_abcdef01\nGT_EXEC_abcdef0123456789", hash)).toBe(`GT_EXEC_${hash}`);
        expect(execDelimiter("a")).not.toBe(execDelimiter("b"));
    });

    it("leaves alone a command that is not the runner's, or whose body does not match its delimiter", () => {
        const { command } = execBashInput({ js: "text(1);", bun: BUN, runner: WORKTREE_RUNNER });

        expect(parseExecBashCommand("ls -la")).toBeUndefined();
        expect(parseExecBashCommand(command.replace("text(1);", "text(2);"))).toBeUndefined();
        expect(parseExecBashCommand(command.replace("/exec/runner.ts", "/other.ts"))).toBeUndefined();
        expect(parseExecBashCommand(`${command}\necho more`)).toBeUndefined();
        expect(parseExecBashCommand("cat <<'EOF'\ntext(1);\nEOF")).toBeUndefined();
    });

    it("is not denied by the shell guard for what its JavaScript says", () => {
        const js = [
            "const cmds = [",
            '  "git checkout -- a.ts",',
            '  "git push --force origin main",',
            "  \"find / -name '*.ts'\",",
            '  "rg -r foo src",',
            '  "ls src 2>/dev/null | wc -l; echo $?",',
            '  "swift build | tail -5; echo ${PIPESTATUS[0]}",',
            '  "log show --last 1m",',
            '  "ls *(N)",',
            '  "docker volume rm data",',
            '  "biome check --write --unsafe .",',
            "];",
            "for (const cmd of cmds) { const r = await tools.exec_command({ cmd }); text(r.output); }",
            ...TRICKY_SCRIPTS,
        ].join("\n");
        const { command } = execBashInput({ js, bun: BUN, runner: WORKTREE_RUNNER, sessionId: "sess-1" });
        const verdict = evaluateCommand(command, { ...DEFAULT_HOOKS_CONFIG, shadow: false }, { rules: SHELL_RULES });

        expect(verdict.violations.map((violation) => violation.ruleId)).toEqual([]);
        expect(verdict.outcome).toBe("allow");
    });

    for (const shell of ["/bin/zsh", "/bin/sh"]) {
        (existsSync(shell) ? it : it.skip)(`runs through ${shell} with the script intact`, async () => {
            const js = [
                "const block = `",
                "EOF",
                "GT_EXEC_00000000",
                "`;",
                'text(block.trim().split("\\n").join(","));',
                'text(["$HOME", "`date`", "$(date)", "\'q\'", \'"dq"\', "\\\\"].join("|"));',
            ].join("\n");
            const { command } = execBashInput({ js, bun: process.execPath, runner: EXEC_RUNNER_PATH });
            const proc = Bun.spawn([shell, "-c", command], { env: process.env, stdout: "pipe", stderr: "pipe" });
            const [stdout, stderr, code] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);

            expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
            expect(stdout.slice(stdout.indexOf("Output:\n") + "Output:\n".length)).toBe(
                "EOF,GT_EXEC_00000000\n$HOME|`date`|$(date)|'q'|\"dq\"|\\"
            );
        });
    }
});

describe("exec in a request's tools", () => {
    const bash = { name: "Bash", description: "Run a command", input_schema: { type: "object" } };
    const read = { name: "Read", description: "Read a file", input_schema: { type: "object" } };

    it("is Codex's custom tool with its lark grammar and no strict flag", () => {
        const definition = execToolDefinition();

        expect(Object.keys(definition).sort()).toEqual(["description", "format", "name", "type"]);
        expect(definition.type).toBe("custom");
        expect(definition.name).toBe("exec");
        expect(definition.format).toEqual({
            type: "grammar",
            syntax: "lark",
            definition:
                "\nstart: pragma_source | plain_source\npragma_source: PRAGMA_LINE NEWLINE SOURCE\nplain_source: SOURCE\n\nPRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/\nNEWLINE: /\\r?\\n/\nSOURCE: /[\\s\\S]+/\n",
        });
        expect(String(definition.description)).toContain("declare const tools: { exec_command(args: {");
        expect(
            String(definition.description).startsWith("Run JavaScript code to orchestrate/compose tool calls\n")
        ).toBe(true);
    });

    it("comes with Bash, by default, the same on every request, and never without Bash or with the setting off", () => {
        const on = execToolBridge({ tools: [bash, read], sessionsIn: undefined });

        expect(on?.definition).toEqual(execToolDefinition());
        expect(execToolBridge({ tools: [read, bash], sessionsIn: {} })?.definition).toEqual(on?.definition);
        expect(
            execToolBridge({ tools: [bash], sessionsIn: { claude: { providers: { codex: { execTool: true } } } } })
        ).toBeDefined();
        expect(
            execToolBridge({ tools: [bash], sessionsIn: { claude: { providers: { codex: { execTool: false } } } } })
        ).toBeUndefined();
        expect(execToolBridge({ tools: [read], sessionsIn: undefined })).toBeUndefined();
        expect(execToolBridge({ tools: [{ ...bash, defer_loading: true }], sessionsIn: undefined })).toBeUndefined();
        expect(execToolBridge({ tools: undefined, sessionsIn: undefined })).toBeUndefined();
    });

    it("replays a runner Bash call as the model's custom_tool_call, the same from a worktree runner and the main one", () => {
        const bridge = execToolBridge({ tools: [bash], sessionsIn: undefined });
        const js = TRICKY_SCRIPTS[2] ?? "";
        const fromWorktree = execBashInput({ js, bun: BUN, runner: WORKTREE_RUNNER, sessionId: "sess-1" });
        const fromMain = execBashInput({ js, bun: "/usr/local/bin/bun", runner: MAIN_RUNNER });
        const expected = { type: "custom_tool_call", call_id: "call_1", name: "exec", input: js };

        expect(bridge?.replayItem({ type: "tool_use", id: "call_1", name: "Bash", input: fromWorktree })).toEqual(
            expected
        );
        expect(bridge?.replayItem({ type: "tool_use", id: "call_1", name: "Bash", input: fromMain })).toEqual(expected);
        expect(
            bridge?.replayItem({ type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } })
        ).toBeUndefined();
        expect(bridge?.replayItem({ type: "tool_use", id: "call_3", name: "Read", input: fromMain })).toBeUndefined();
    });
});
