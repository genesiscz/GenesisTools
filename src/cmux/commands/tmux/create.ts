import { createTmuxSession, sessionExists } from "@app/utils/tmux/sessions";
import { makeStandaloneTmuxSessionName } from "@app/utils/tmux/naming";
import { out } from "@app/logger";
import type { Command } from "commander";

interface CreateFlags {
    name?: string;
    cwd?: string;
    command?: string;
}

export function registerTmuxCreateCommand(parent: Command): void {
    parent
        .command("create")
        .description("Create a detached tmux session (visible in dev-dashboard tmux hub)")
        .option("-n, --name <name>", "Session name (default: cmux-<id>)")
        .option("-c, --cwd <path>", "Working directory (default: cwd)")
        .option("--command <shell>", "Command to run in the session (default: $SHELL)")
        .action((flags: CreateFlags) => {
            const sessionName = flags.name?.trim() || makeStandaloneTmuxSessionName();
            const cwd = flags.cwd ?? process.cwd();
            const command = flags.command ?? process.env.SHELL ?? "/bin/zsh";

            if (sessionExists(sessionName)) {
                throw new Error(`tmux session ${sessionName} already exists`);
            }

            createTmuxSession(sessionName, cwd, command);
            out.result({ sessionName, cwd, command });
        });
}
