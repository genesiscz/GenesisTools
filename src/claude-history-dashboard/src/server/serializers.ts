import type { SessionMetadataRecord } from "@app/claude/lib/history/cache";
import { getFileIndex } from "@app/claude/lib/history/cache";
import type { getAllConversations } from "@app/claude/lib/history/search";
import type { ConversationMessage, ToolResultBlock, ToolUseBlock } from "@app/utils/claude/types";

import { SafeJSON } from "@app/utils/json";

// Serializable types for client/server communication
export interface SerializableConversation {
	filePath: string;
	project: string;
	sessionId: string;
	timestamp: string; // ISO string
	summary?: string;
	customTitle?: string;
	gitBranch?: string;
	messageCount: number;
	isSubagent: boolean;
}

export interface SidebarSession {
	sessionId: string;
	project: string;
	summary?: string;
	customTitle?: string;
	timestamp: string;
	isSubagent: boolean;
	messageCount: number;
}

export interface SerializableConversationDetail extends SerializableConversation {
	messages: Array<{
		type: string;
		role?: string;
		content: string;
		timestamp?: string;
		toolUses?: Array<{ name: string; input?: object }>;
		toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
	}>;
}

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheCreateTokens: number;
	cacheReadTokens: number;
}

export interface SerializableStats {
	totalConversations: number;
	totalMessages: number;
	projectCounts: Record<string, number>;
	toolCounts: Record<string, number>;
	dailyActivity: Record<string, number>;
	hourlyActivity: Record<string, number>;
	subagentCount: number;
	// Token analytics
	tokenUsage: TokenUsage;
	dailyTokens: Record<string, TokenUsage>;
	// Model usage
	modelCounts: Record<string, number>;
	// Branch activity
	branchCounts: Record<string, number>;
	// Conversation length distribution
	conversationLengths: number[];
}

export interface QuickStatsResponse {
	totalConversations: number;
	totalMessages: number;
	subagentCount: number;
	projectCount: number;
	isCached: boolean;
}

// Helper to serialize a conversation result
export function serializeResult(result: Awaited<ReturnType<typeof getAllConversations>>[0]): SerializableConversation {
	// Use userMessageCount + assistantMessageCount when available (from getAllConversations),
	// otherwise fall back to matchedMessages.length (from searchConversations)
	const messageCount =
		result.userMessageCount !== undefined && result.assistantMessageCount !== undefined
			? result.userMessageCount + result.assistantMessageCount
			: result.matchedMessages.length;

	return {
		filePath: result.filePath,
		project: result.project,
		sessionId: result.sessionId,
		timestamp: result.timestamp.toISOString(),
		summary: result.summary,
		customTitle: result.customTitle,
		gitBranch: result.gitBranch,
		messageCount,
		isSubagent: result.isSubagent,
	};
}

export function serializeSessionMetadata(record: SessionMetadataRecord): SerializableConversation {
	const sessionId = record.sessionId || record.filePath.split("/").pop()?.replace(/\.jsonl$/, "") || "unknown";
	const fileIndex = getFileIndex(record.filePath);

	return {
		filePath: record.filePath,
		project: record.project,
		sessionId,
		timestamp: record.firstTimestamp ?? new Date(record.mtime).toISOString(),
		summary: record.summary,
		customTitle: record.customTitle,
		gitBranch: record.gitBranch,
		messageCount: fileIndex?.messageCount ?? 0,
		isSubagent: record.isSubagent,
	};
}

export function toSidebarSession(record: SessionMetadataRecord): SidebarSession {
	const serialized = serializeSessionMetadata(record);

	return {
		sessionId: serialized.sessionId,
		project: serialized.project,
		summary: serialized.summary,
		customTitle: serialized.customTitle,
		timestamp: serialized.timestamp,
		isSubagent: serialized.isSubagent,
		messageCount: serialized.messageCount,
	};
}

// Helper to extract text from a message
export function extractMessageContent(msg: ConversationMessage): string {
	if (msg.type === "user" || msg.type === "assistant") {
		const content = msg.message.content;

		if (typeof content === "string") {
			return content;
		}

		if (Array.isArray(content)) {
			return content
				.filter((b) => typeof b === "object" && b !== null && "type" in b)
				.map((b) => {
					if (b.type === "text") {
						return b.text || "";
					}

					if (b.type === "thinking") {
						return b.thinking || "";
					}

					// tool_use and tool_result are handled separately - no warning needed
					return "";
				})
				.join("\n");
		}
	}

	if (msg.type === "summary" && "summary" in msg) {
		return (msg as { summary: string }).summary;
	}

	return "";
}

// Helper to extract tool uses from a message
export function extractToolUses(msg: ConversationMessage): Array<{ name: string; input?: object }> {
	if (msg.type !== "assistant") {
		return [];
	}

	const content = msg.message.content;

	if (!Array.isArray(content)) {
		return [];
	}

	return content
		.filter((b): b is ToolUseBlock => typeof b === "object" && b !== null && "type" in b && b.type === "tool_use")
		.map((b) => ({ name: b.name, input: b.input }));
}

// Helper to extract tool results from a message
export function extractToolResults(
	msg: ConversationMessage
): Array<{ toolUseId: string; content: string; isError?: boolean }> {
	if (msg.type !== "user") {
		return [];
	}

	const content = msg.message.content;

	if (!Array.isArray(content)) {
		return [];
	}

	return content
		.filter((b): b is ToolResultBlock => typeof b === "object" && b !== null && "type" in b && b.type === "tool_result")
		.map((b) => ({
			toolUseId: b.tool_use_id,
			content: typeof b.content === "string" ? b.content : (SafeJSON.stringify(b.content, null, 2) ?? ""),
			isError: b.is_error,
		}));
}
