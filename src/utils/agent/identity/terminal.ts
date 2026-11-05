import type { TerminalApp } from "./types";

function trimmed(value: string | undefined): string | null {
    return value?.trim() || null;
}

/**
 * The terminal app a caller's environment names: its program (`TERM_PROGRAM`) and its own session ids (iTerm2's
 * `ITERM_SESSION_ID`, the `TERM_SESSION_ID` Apple Terminal and iTerm2 both set), trimmed; undefined when none is
 * set. Pure: the environment snapshot only. cmux and tmux have their own readers beside it.
 */
export function readTerminalApp(env: NodeJS.ProcessEnv): TerminalApp | undefined {
    const app: TerminalApp = {
        program: trimmed(env.TERM_PROGRAM),
        itermSessionId: trimmed(env.ITERM_SESSION_ID),
        termSessionId: trimmed(env.TERM_SESSION_ID),
    };

    return app.program || app.itermSessionId || app.termSessionId ? app : undefined;
}
