/**
 * Agent-Agnostic Message Model
 *
 * These types represent the RENDERING view of a conversation, not the wire format.
 * Any agent (Claude Code, Codex, pi, custom) maps its native format into these.
 */

// ─── Provider ───────────────────────────────────────────────────────────────

export type AgentProvider = "claude-code" | "codex" | "pi" | "custom";

// ─── Content Blocks ─────────────────────────────────────────────────────────

export type AgentContentBlock =
    | AgentTextBlock
    | AgentThinkingBlock
    | AgentToolCallBlock
    | AgentToolResultBlock
    | AgentImageBlock
    | AgentNotificationBlock;

export interface AgentTextBlock {
    type: "text";
    text: string;
}

export interface AgentThinkingBlock {
    type: "thinking";
    text: string;
    signature?: string;
}

export interface AgentToolCallBlock {
    type: "tool_call";
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface AgentToolResultBlock {
    type: "tool_result";
    toolCallId: string;
    content: string;
    isError?: boolean;
}

export interface AgentImageBlock {
    type: "image";
    mediaType: string;
    data: string;
}

export interface AgentNotificationBlock {
    type: "agent_notification";
    agentId: string;
    status: string;
    summary: string;
}

// ─── Message ────────────────────────────────────────────────────────────────

export type AgentRole = "user" | "assistant" | "system" | "metadata";

export interface AgentMessage {
    role: AgentRole;
    blocks: AgentContentBlock[];
    timestamp?: Date;
    model?: string;
    usage?: AgentUsage;
    /** Agent-specific metadata (gitBranch, sessionId, uuid, etc.) */
    meta?: Record<string, unknown>;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

export interface AgentUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

// ─── Session Info ───────────────────────────────────────────────────────────

export interface AgentSessionInfo {
    id: string;
    provider: AgentProvider;
    title?: string;
    summary?: string;
    branch?: string;
    project?: string;
    startedAt?: Date;
    lastActiveAt?: Date;
    isSubagent?: boolean;
    /** Custom metadata for provider-specific fields. */
    meta?: Record<string, unknown>;
}
