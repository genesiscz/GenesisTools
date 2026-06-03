import { out } from "@app/logger";
import { makeStandaloneTmuxSessionName } from "@app/utils/tmux/naming";
import { attachTmuxSession, createTmuxSession, sessionExists } from "@app/utils/tmux/sessions";
import type { Command } from "commander";

interface CreateFlags {
    name?: string;
    cwd?: string;
    command?: string;
    attach?: boolean;
}

export function registerCreateCommand(program: Command): void {
    program
        .command("create")
        .description("Create a detached tmux session (visible in dev-dashboard tmux hub)")
        .option("-n, --name <name>", "Session name (default: cmux-<id>)")
        .option("-c, --cwd <path>", "Working directory (default: cwd)")
        .option("--command <shell>", "Command to run in the session (default: $SHELL)")
        .option("-a, --attach", "Attach to the new session immediately (foreground; needs a TTY)")
        .action((flags: CreateFlags) => {
            const sessionName = flags.name?.trim() || makeStandaloneTmuxSessionName();
            const cwd = flags.cwd ?? process.cwd();
            const command = flags.command ?? process.env.SHELL ?? "/bin/zsh";

            if (sessionExists(sessionName)) {
                throw new Error(`tmux session ${sessionName} already exists`);
            }

            createTmuxSession(sessionName, cwd, command);

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
        });
}
