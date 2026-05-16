export interface TtydSession {
    id: string;
    port: number;
    command: string;
    cwd: string;
    pid: number;
    startedAt: string;
    tmuxSessionName?: string;
}

export type SplitNode =
    | { kind: "leaf"; sessionId: string }
    | { kind: "split"; direction: "row" | "column"; ratio: number; children: [SplitNode, SplitNode] };
