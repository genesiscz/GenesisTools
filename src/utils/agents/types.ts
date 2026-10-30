/**
 * Agent-Agnostic Message Model
 *
 * These types represent the RENDERING view of a conversation, not the wire format.
 * Any agent (Claude Code, Codex, pi, custom) maps its native format into these.
 */

import type { HarnessId } from "@genesiscz/utils/harness/types";

// ─── Provider ───────────────────────────────────────────────────────────────

/**
 * Who wrote the conversation. Claude is spelled `claude-code` here, as in `AgentRuntimeContext.agent`; the other
 * harnesses keep their id, so a new harness joins without an edit. Renamed from `AgentProvider`, which is also the
 * process classifier's name (`src/utils/process/classify.ts`).
 */
export type AgentMessageProvider = "claude-code" | Exclude<HarnessId, "claude"> | "pi" | "custom";

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
    provider: AgentMessageProvider;
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
