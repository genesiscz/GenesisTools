import type { getAllConversations } from "@app/claude/lib/history/search";
import type { ConversationMessage, ToolResultBlock, ToolUseBlock } from "@app/utils/claude/types";

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

// Helper to extract text from a message
export function extractMessageContent(msg: ConversationMessage): string {
	if (msg.type === "user" || msg.type === "assistant") {
		const content = msg.message.content;

		if (typeof content === "string") {
			return content;
		}

		if (Array.isArray(content)) {
			return content
				.filter(
					(b): b is { type: string; text?: string; thinking?: string } =>
						typeof b === "object" && b !== null && "type" in b
				)
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
			content: typeof b.content === "string" ? b.content : (JSON.stringify(b.content, null, 2) ?? ""),
			isError: b.is_error,
		}));
}
