import type { SourceMessage, TranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import type { ImageAttachment, ImageAttachmentInput } from "@genesiscz/utils/image/attachments";

/** `message`: an agent-to-user message with no question (`inbox_send`, `tools question message`). */
export type QaTag = "question" | "action" | "directive" | "message";
/** `ask` marks an entry that came from answering a blocking pending form, not a log-after call. */
export type QaSource = "question" | "mcp" | "skill" | "cli" | "ask";
export type QaAgent = "claude-code" | "codex" | "grok" | "copilot" | "unknown";
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
    attachments?: ImageAttachment[];
    source: QaSource;
    turnUuid: string | null;
    transcriptAnchor?: TranscriptAnchor;
}

export interface RecordInput {
    projectPath?: string;
    sourceMessage?: SourceMessage;
    question: string;
    answer: string;
    tag: QaTag;
    refs?: QaRef[];
    attachments?: ImageAttachmentInput[];
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
    context: Pick<
        QaEntry,
        | "agent"
        | "sessionId"
        | "project"
        | "repoRoot"
        | "cwd"
        | "branch"
        | "commitSha"
        | "isWorktree"
        | "worktreePath"
        | "transcriptAnchor"
    >;
    id: string;
    sinks: SinkResult[];
    superseded?: string;
    attachments?: ImageAttachment[];
}
