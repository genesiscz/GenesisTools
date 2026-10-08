import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    liveSessionIO,
    parseFocusFlag,
    type SessionNewIO,
    type SessionNewResult,
    startDevSession,
} from "../lib/session-new";

const { log } = logger.scoped("cmux-session");

interface SessionNewFlags {
    repo?: string;
    account?: string;
    prompt?: string;
    promptFile?: string;
    name?: string;
    viaTmux?: boolean;
    focus?: string | boolean;
    json?: boolean;
}

function blank(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

async function defaultClaudeAccount(): Promise<string> {
    const config = await AIConfig.load();
    const account = config.getDefaultAccount("claude");

    if (!account) {
        throw new Error("no default Claude account; pass --account <name>");
    }

    log.debug({ account: account.name }, "using the default Claude account");
    return account.name;
}

function printHuman(result: SessionNewResult): void {
    out.println(`${result.workspace}  ${result.surface}  ${result.window}`);
    out.println(result.cwd);

    if (result.tmuxSession) {
        out.println(`tmux ${result.tmuxSession}`);
    }

    out.println(result.command);
}

export async function runSessionNew(options: SessionNewFlags, io: SessionNewIO = liveSessionIO()): Promise<void> {
    const focus = parseFocusFlag(options.focus);

    if (!focus.ok) {
        out.error(
            suggestEnumFlag("tools cmux", "--focus", ["true", "false"], {
                subcommand: ["session", "new"],
                given: focus.given,
            })
        );
        process.exitCode = 1;
        return;
    }

    const prompt = blank(options.prompt);
    const promptFile = blank(options.promptFile);

    if (prompt && promptFile) {
        out.error("pass only one of --prompt and --prompt-file");
        process.exitCode = 1;
        return;
    }

    const repo = options.repo?.trim();

    if (!repo) {
        out.error("--repo is required");
        process.exitCode = 1;
        return;
    }

    let absolutePrompt: string | undefined;

    if (promptFile) {
        absolutePrompt = resolve(promptFile);

        if (!existsSync(absolutePrompt) || !statSync(absolutePrompt).isFile()) {
            throw new Error(`no such prompt file: ${absolutePrompt}`);
        }
    }

    const result = await startDevSession(
        {
            repo,
            account: blank(options.account) ?? (await defaultClaudeAccount()),
            prompt,
            promptFile: absolutePrompt,
            name: blank(options.name),
            viaTmux: options.viaTmux === true,
            focus: focus.focus,
            home: homedir(),
            cwd: process.cwd(),
        },
        io
    );

    if (options.json) {
        out.result(result);
    } else {
        printHuman(result);
    }

    await out.flush();
}

export function registerSessionCommand(program: Command): void {
    const session = program.command("session").description("Open a dev session in the focused cmux window");

    session
        .command("new")
        .description("Create a background workspace in the focused cmux window and start Claude there")
        .requiredOption("--repo <name|path>", "Project name under ~/Tresors/Projects, or a directory path")
        .option("--account <name>", "Claude account. Omit to use the default account.")
        .option("--prompt <text>", `Initial prompt. Passed after -- to ${toolCommand("claude run")}.`)
        .option("--prompt-file <path>", "Read the prompt from a file when the workspace command runs")
        .option("--name <title>", "Workspace title. Rename is best-effort.")
        .option("--via-tmux", "Run Claude inside a detached tmux session and attach the workspace to it")
        .option("--focus [value]", "Focus the new workspace: true or false (default: false)")
        .option("--json", "Print workspace, surface, window, tmuxSession, cwd, and command as JSON")
        .action(async (options: SessionNewFlags) => {
            try {
                await runSessionNew(options);
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
