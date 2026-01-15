/**
 * Claude Code Conversation History Types
 * Based on analysis of ~/.claude/projects/ JSONL files
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
	| "subagent";

export type SystemSubtype =
	| "stop_hook_summary"
	| "turn_duration"
	| "api_error"
	| "local_command"
	| "compact_boundary";

export type ContentBlockType = "tool_use" | "tool_result" | "thinking" | "text";

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
}

export interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | ContentBlock[];
	is_error?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

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
	stop_reason: "end_turn" | "tool_use" | "stop_sequence" | null;
	stop_sequence: string | null;
	usage: Usage;
}

// =============================================================================
// Top-Level Message Types
// =============================================================================

interface BaseMessage {
	uuid: string;
	parentUuid: string | null;
	sessionId: string;
	timestamp: string;
	cwd?: string;
	gitBranch?: string;
	isSidechain?: boolean;
	userType: UserType;
	version?: number;
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
	slug?: string;
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

// Subagent messages have their own discriminant to avoid breaking the union
export interface SubagentMessage extends BaseMessage {
	type: "subagent";
	role: "user" | "assistant";
	message: UserMessageContent | AssistantMessageContent;
	agentId?: string;
	sourceToolAssistantUUID?: string;
	toolUseResult?: unknown;
}

export type ConversationMessage =
	| UserMessage
	| AssistantMessage
	| SystemMessage
	| SummaryMessage
	| CustomTitleMessage
	| FileHistorySnapshot
	| QueueOperation
	| SubagentMessage;

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
// Search & Filter Types
// =============================================================================

export interface SearchFilters {
	query?: string;
	exact?: boolean;
	regex?: boolean;
	file?: string;
	tool?: string;
	project?: string;
	since?: Date;
	until?: Date;
	agentsOnly?: boolean;
	excludeAgents?: boolean;
	excludeThinking?: boolean;
	limit?: number;
	context?: number;
	summaryOnly?: boolean;
	excludeCurrentSession?: string;
	conversationDate?: Date;
	conversationDateUntil?: Date;
	commitHash?: string;
	commitMessage?: string;
	sortByRelevance?: boolean;
}

export interface SearchResult {
	filePath: string;
	project: string;
	sessionId: string;
	timestamp: Date;
	summary?: string;
	customTitle?: string;
	gitBranch?: string;
	matchedMessages: ConversationMessage[];
	contextMessages?: ConversationMessage[];
	isSubagent: boolean;
	relevanceScore?: number;
	commitHashes?: string[];
	userMessageCount?: number;
	assistantMessageCount?: number;
}

export interface ConversationMetadata {
	filePath: string;
	project: string;
	sessionId: string;
	firstTimestamp?: Date;
	lastTimestamp?: Date;
	summary?: string;
	customTitle?: string;
	gitBranch?: string;
	messageCount: number;
	isSubagent: boolean;
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
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];
