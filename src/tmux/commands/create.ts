import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { makeStandaloneTmuxSessionName } from "@genesiscz/utils/tmux/naming";
import { attachTmuxSession, createTmuxSession, sessionExists } from "@genesiscz/utils/tmux/sessions";
import type { Command } from "commander";

interface CreateFlags {
    name?: string;
    cwd?: string;
    command?: string;
    attach?: boolean;
}

export function addCreateCommand(parent: Command): Command {
    return parent
        .command("create")
        .description("Create a detached tmux session (visible in dev-dashboard tmux hub)")
        .option("-n, --name <name>", "Session name (default: cmux-<id>)")
        .option("-c, --cwd <path>", "Working directory (default: cwd)")
        .option("--command <shell>", "Command to run in the session (default: $SHELL)")
        .option("-a, --attach", "Attach to the new session immediately (foreground; needs a TTY)")
        .action(async (flags: CreateFlags) => {
            await runCreate(flags);
        });
}

export function registerCreateCommand(program: Command): void {
    addCreateCommand(program);
}

async function runCreate(flags: CreateFlags): Promise<void> {
    const sessionName = flags.name?.trim() || makeStandaloneTmuxSessionName();
    const cwd = flags.cwd ?? process.cwd();
    const command = flags.command ?? env.paths.getShell("/bin/zsh");

    if (await sessionExists(sessionName)) {
        throw new Error(`tmux session ${sessionName} already exists`);
    }

    await createTmuxSession(sessionName, cwd, command);

    if (!flags.attach) {
        out.result({ sessionName, cwd, command });
        return;
    }

    if (!process.stdin.isTTY) {
        throw new Error(
            `--attach needs a TTY (stdin is not a terminal). Session ${sessionName} was created — attach manually with: tmux attach-session -t ${sessionName}`
        );
    }

    attachTmuxSession(sessionName);
}
