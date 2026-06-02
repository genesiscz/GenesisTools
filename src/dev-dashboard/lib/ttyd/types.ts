export interface TtydSession {
    id: string;
    port: number;
    command: string;
    cwd: string;
    pid: number;
    startedAt: string;
    tmuxSessionName?: string;
    /** User-set display name; falls back to "<command> :<port>" when unset. */
    name?: string;
    /**
     * Live command in the bound tmux session's active pane (`#{pane_current_command}`), refreshed on
     * every `listTtyd()`. Drives an auto-name when the user has not set `name`. NOT persisted — it is
     * a derived live fact, recomputed each read. Absent when the session has no tmux binding.
     */
    lastCommand?: string;
}

export type SplitNode =
    | { kind: "leaf"; sessionId: string }
    | { kind: "split"; direction: "row" | "column"; ratio: number; children: [SplitNode, SplitNode] };
