import { env } from "@genesiscz/utils/env";

/**
 * True when this process runs inside a tmux client. tmux exports `TMUX` (the server socket) to every pane's shell,
 * so the variable says there is a client to switch or a window to add to. It is a different fact from the pane
 * (`readTmuxTerminal`): a blank value names no server, as an unset variable a shell expanded names none.
 */
export function insideTmux(environment: NodeJS.ProcessEnv = env.getProcessEnv()): boolean {
    return Boolean(environment.TMUX?.trim());
}
