export interface TtydSession {
    id: string;
    port: number;
    command: string;
    cwd: string;
    pid: number;
    startedAt: string;
    tmuxSessionName?: string;
    /**
     * User-set display name. When set (including after a unified rename), tabs and Session Hub share
     * this identity with `tmuxSessionName`. Falls back via {@link deriveTtydDisplayName}.
     */
    name?: string;
    /**
     * Live command in the bound tmux session's active pane (`#{pane_current_command}`), refreshed on
     * every `listTtyd()`. Surfaced as secondary meta in the hub / CLI — not the primary tab label when
     * a tmux binding exists. NOT persisted — derived live fact, recomputed each read.
     */
    lastCommand?: string;
    /**
     * Claude Code's live topic from `#{pane_title}`, marker stripped. Informational ONLY: it is
     * never promoted into `name`, because auto-topics and `/rename` are indistinguishable on the
     * wire and promoting them destroyed manual names. NOT persisted — recomputed each read.
     */
    title?: string;
}

export type SplitNode =
    | { kind: "leaf"; sessionId: string }
    | { kind: "split"; direction: "row" | "column"; ratio: number; children: [SplitNode, SplitNode] };
