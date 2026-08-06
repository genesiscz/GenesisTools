export interface TmuxSessionInfo {
    name: string;
    attached: number;
    windows: number;
    /**
     * Active-pane facts, straight from tmux. These carry the ONLY information available for a
     * session with no ttyd binding (the dashboard used to read command/cwd off the ttyd session,
     * so a plain `tools tmux create` session rendered as a bare name with no meta at all).
     * All of it rides the same single `list-sessions` call as the fields above.
     */
    command?: string;
    cwd?: string;
    /** Raw `#{pane_title}` — Claude Code's `<spinner> <topic>`, a shell's own title, or empty. */
    title?: string;
    /** Unix seconds. */
    created?: number;
    /** Unix seconds of the last activity in the session. */
    lastActivity?: number;
}
