/**
 * Claude Code Conversation History Types
 * Shared types for JSONL session files at ~/.claude/projects/
 *
 * Moved from src/claude-history/types.ts to be reusable across tools.
 */

// =============================================================================
// Message Type Discriminants
// =============================================================================

export type MessageType =
    | "user"
    | "assistant"
    | "system"
    | "summary"
    | "custom-title"
    | "file-history-snapshot"
    | "queue-operation"
    | "subagent"
    | "progress"
    | "pr-link";

export type SystemSubtype = "stop_hook_summary" | "turn_duration" | "api_error" | "local_command" | "compact_boundary";

export type ContentBlockType = "tool_use" | "tool_result" | "thinking" | "text" | "tool_reference" | "image";

export type UserType = "external" | "internal";

// =============================================================================
// Content Blocks (in assistant/user messages)
// =============================================================================

export interface TextBlock {
    type: "text";
    text: string;
}

export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
    signature?: string;
}

export interface ToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
    caller?: { type: string; [key: string]: unknown };
}

export interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | ContentBlock[];
    is_error?: boolean;
}

/** Tool reference block — appears inside tool_result.content[] when ToolSearch returns tool definitions */
export interface ToolReferenceBlock {
    type: "tool_reference";
    tool_name: string;
}

/** Image block — appears inside tool_result.content[] when Read tool reads an image file */
export interface ImageBlock {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ToolReferenceBlock | ImageBlock;

// =============================================================================
// Usage Statistics
// =============================================================================

export interface CacheCreation {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
}

export interface Usage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: CacheCreation;
    service_tier?: string;
    inference_geo?: string;
}

// =============================================================================
// Inner Message Structures
// =============================================================================

export interface UserMessageContent {
    role: "user";
    content: string | ContentBlock[];
}

export interface AssistantMessageContent {
    role: "assistant";
    content: ContentBlock[];
    id: string;
    model: string;
    type: "message";
    stop_reason: "end_turn" | "tool_use" | "stop_sequence" | "max_tokens" | null;
    stop_sequence: string | null;
    usage: Usage;
}

// =============================================================================
// Top-Level Message Types
// =============================================================================

export interface BaseMessage {
    uuid: string;
    parentUuid: string | null;
    sessionId: string;
    timestamp: string;
    cwd?: string;
    gitBranch?: string;
    isSidechain?: boolean;
    userType: UserType;
    version?: string | number;
    slug?: string;
    agentId?: string;
}

export interface UserMessage extends BaseMessage {
    type: "user";
    message: UserMessageContent;
    isMeta?: boolean;
}

export interface AssistantMessage extends BaseMessage {
    type: "assistant";
    message: AssistantMessageContent;
    requestId?: string;
}

export interface SystemMessage extends BaseMessage {
    type: "system";
    subtype: SystemSubtype;
    level?: "error" | "warning" | "info" | "suggestion";
    stopReason?: string;
    hasOutput?: boolean;
    hookCount?: number;
    hookErrors?: unknown[];
    hookInfos?: unknown[];
    preventedContinuation?: boolean;
    toolUseID?: string;
}

export interface SummaryMessage {
    type: "summary";
    summary: string;
    leafUuid: string;
}

export interface CustomTitleMessage {
    type: "custom-title";
    customTitle: string;
    sessionId: string;
}

export interface FileHistorySnapshot {
    type: "file-history-snapshot";
    messageId: string;
    snapshot: {
        messageId: string;
        trackedFileBackups: Record<string, unknown>;
        timestamp: string;
    };
    isSnapshotUpdate: boolean;
}

export interface QueueOperation {
    type: "queue-operation";
    operation: "enqueue" | "popAll";
    timestamp: string;
    sessionId: string;
    content: string;
}

export interface SubagentMessage extends BaseMessage {
    type: "subagent";
    role: "user" | "assistant";
    message: UserMessageContent | AssistantMessageContent;
    agentId?: string;
    sourceToolAssistantUUID?: string;
    toolUseResult?: unknown;
}

// =============================================================================
// Progress Message Types
// =============================================================================

export type ProgressDataType =
    | "hook_progress"
    | "bash_progress"
    | "agent_progress"
    | "mcp_progress"
    | "search_results_received"
    | "query_update"
    | "waiting_for_task";

export interface HookProgressData {
    type: "hook_progress";
    hookEvent: string;
    hookName: string;
    command: string;
}

export interface BashProgressData {
    type: "bash_progress";
    output: string;
    fullOutput: string;
    elapsedTimeSeconds: number;
    totalLines: number;
}

export interface AgentProgressData {
    type: "agent_progress";
    [key: string]: unknown;
}

export interface McpProgressData {
    type: "mcp_progress";
    [key: string]: unknown;
}

export interface GenericProgressData {
    type: "search_results_received" | "query_update" | "waiting_for_task";
    [key: string]: unknown;
}

export type ProgressData =
    | HookProgressData
    | BashProgressData
    | AgentProgressData
    | McpProgressData
    | GenericProgressData;

export interface ProgressMessage extends BaseMessage {
    type: "progress";
    data: ProgressData;
    toolUseID: string;
    parentToolUseID: string;
}

export interface PrLinkMessage {
    type: "pr-link";
    url: string;
    sessionId: string;
    timestamp: string;
}

export type ConversationMessage =
    | UserMessage
    | AssistantMessage
    | SystemMessage
    | SummaryMessage
    | CustomTitleMessage
    | FileHistorySnapshot
    | QueueOperation
    | SubagentMessage
    | ProgressMessage
    | PrLinkMessage;

// =============================================================================
// Global History Entry (history.jsonl)
// =============================================================================

export interface GlobalHistoryEntry {
    display: string;
    pastedContents: Record<string, unknown>;
    timestamp: number;
    project: string;
}

// =============================================================================
// Tool Names (known tools)
// =============================================================================

export const KNOWN_TOOLS = [
    "Bash",
    "Edit",
    "Write",
    "Read",
    "Grep",
    "Glob",
    "TodoWrite",
    "Task",
    "TaskOutput",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "Skill",
    "LSP",
    "AskUserQuestion",
    "ExitPlanMode",
    "EnterPlanMode",
    "WebFetch",
    "WebSearch",
    "KillShell",
    "Explore",
    "NotebookEdit",
    "ToolSearch",
    "TeamCreate",
    "TeamDelete",
    "SendMessage",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];
