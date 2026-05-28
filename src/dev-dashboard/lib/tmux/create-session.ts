import { createTmuxSession, sessionExists } from "@app/utils/tmux/sessions";
import { makeStandaloneTmuxSessionName } from "@app/utils/tmux/naming";

export function createStandaloneTmuxSession(opts: { name?: string; cwd?: string; command?: string } = {}): {
    sessionName: string;
    cwd: string;
    command: string;
} {
    const sessionName = opts.name?.trim() || makeStandaloneTmuxSessionName();
    const cwd = opts.cwd ?? process.cwd();
    const command = opts.command ?? process.env.SHELL ?? "/bin/zsh";

    if (sessionExists(sessionName)) {
        throw new Error(`tmux session ${sessionName} already exists`);
    }

    createTmuxSession(sessionName, cwd, command);

    return { sessionName, cwd, command };
}
