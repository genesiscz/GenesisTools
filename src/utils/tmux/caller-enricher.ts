import type { TmuxTerminal } from "@genesiscz/utils/agent/identity/types";

/**
 * The tmux pane a caller's environment names, or undefined outside tmux. A whitespace-only `TMUX_PANE` is what an
 * unset variable expands to in a shell command, so it names no pane (it used to beat a valid cmux surface in
 * send-self). Pure and synchronous: no `tmux` call.
 */
export function readTmuxTerminal(env: NodeJS.ProcessEnv): TmuxTerminal | undefined {
    const pane = env.TMUX_PANE?.trim();
    return pane ? { pane } : undefined;
}
