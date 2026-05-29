export type QaTag = "question" | "action" | "directive";
export type QaSource = "question" | "mcp" | "skill" | "cli";
export type QaAgent = "claude-code" | "codex" | "unknown";
export interface QaRef {
    type: "commit" | "file" | "url" | "plan";
    value: string;
}

export interface QaEntry {
    id: string;
    ts: number;
    sessionId: string;
    sessionTitle: string | null;
    project: string;
    repoRoot: string;
    cwd: string;
    branch: string | null;
    commitSha: string | null;
    commitMessage: string | null;
    agent: QaAgent;
    isWorktree: boolean;
    worktreePath: string | null;
    aiAgent: string | null;
    agentLabel: string | null;
    tag: QaTag;
    question: string;
    answerMd: string;
    refs: QaRef[];
    source: QaSource;
    turnUuid: string | null;
}

export interface RecordInput {
    question: string;
    answer: string;
    tag: QaTag;
    refs?: QaRef[];
    agentLabel?: string;
    source: QaSource;
    sessionId?: string;
    project?: string;
}

export interface SinkResult {
    name: string;
    ok: boolean;
    error?: string;
    remedy?: string;
}
export interface RecordResult {
    id: string;
    sinks: SinkResult[];
    superseded?: string;
}
