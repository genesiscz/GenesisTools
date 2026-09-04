export type AgentKind = "claude" | "grok" | "codex";

export interface AgentSession {
    kind: AgentKind;
    sessionId: string;
    cwd: string;
    title: string;
    summary?: string;
    prompt?: string;
    mtime: Date;
    filePath: string;
    project?: string;
    account?: string | null;
}

export interface AgentSearchFilters {
    query?: string;
    /** Absolute working directory; compared exactly. */
    cwd?: string;
    /** Project leaf name (the last path segment of the cwd); compared exactly. */
    project?: string;
    all?: boolean;
    since?: Date;
    until?: Date;
    limit?: number;
    exact?: boolean;
    regex?: boolean;
}

export interface AgentSearchHit extends AgentSession {
    matchedText?: string;
}

export interface AgentSessionAdapter {
    kind: AgentKind;
    list(filters: AgentSearchFilters): Promise<AgentSession[]>;
    search(filters: AgentSearchFilters): Promise<AgentSearchHit[]>;
}
