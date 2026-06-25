import { env } from "@app/utils/env";
import { makeStandaloneTmuxSessionName } from "@app/utils/tmux/naming";
import { createTmuxSession, sessionExists } from "@app/utils/tmux/sessions";

export function createStandaloneTmuxSession(opts: { name?: string; cwd?: string; command?: string } = {}): {
    sessionName: string;
    cwd: string;
    command: string;
} {
    const sessionName = opts.name?.trim() || makeStandaloneTmuxSessionName();
    const cwd = opts.cwd ?? process.cwd();
    const command = opts.command ?? env.paths.getShell("/bin/zsh");

    if (sessionExists(sessionName)) {
        throw new Error(`tmux session ${sessionName} already exists`);
    }

    createTmuxSession(sessionName, cwd, command);

    return { sessionName, cwd, command };
}
