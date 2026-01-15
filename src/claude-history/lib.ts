/**
 * Claude Code Conversation History Library
 * Reusable functions for searching and parsing conversation history
 */

import { glob } from "glob";
import { homedir } from "os";
import { resolve, basename } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import type {
	ConversationMessage,
	SearchFilters,
	SearchResult,
	AssistantMessage,
	UserMessage,
	SummaryMessage,
	CustomTitleMessage,
	ToolUseBlock,
	TextBlock,
	ThinkingBlock,
	ConversationMetadata,
} from "./types";

// Re-export all types
export * from "./types";

export const CLAUDE_DIR = resolve(homedir(), ".claude");
export const PROJECTS_DIR = resolve(CLAUDE_DIR, "projects");

// =============================================================================
// File Discovery
// =============================================================================

export async function findConversationFiles(filters: SearchFilters): Promise<string[]> {
	const patterns: string[] = [];

	if (filters.project && filters.project !== "all") {
		// Search specific project
		const projectPattern = `${PROJECTS_DIR}/*${filters.project}*/**/*.jsonl`;
		patterns.push(projectPattern);
	} else {
		// Search all projects
		patterns.push(`${PROJECTS_DIR}/**/*.jsonl`);
	}

	if (!filters.excludeAgents && !filters.agentsOnly) {
		// Include both main and subagent files (default)
	} else if (filters.agentsOnly) {
		// Only subagent files
		patterns.length = 0;
		patterns.push(`${PROJECTS_DIR}/**/subagents/*.jsonl`);
		patterns.push(`${PROJECTS_DIR}/**/agent-*.jsonl`);
	}

	let files: string[] = [];
	for (const pattern of patterns) {
		const matched = await glob(pattern, { absolute: true });
		files.push(...matched);
	}

	// Remove duplicates
	files = [...new Set(files)];

	// Filter out subagents if requested
	if (filters.excludeAgents) {
		files = files.filter((f) => !f.includes("/subagents/") && !basename(f).startsWith("agent-"));
	}

	// Sort by modification time (most recent first)
	const fileStats = await Promise.all(
		files.map(async (f) => {
			const stat = await Bun.file(f).stat();
			return { path: f, mtime: stat?.mtime ?? new Date(0) };
		}),
	);
	fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

	return fileStats.map((f) => f.path);
}

export function extractProjectName(filePath: string): string {
	// Extract project name from path like:
	// /Users/Martin/.claude/projects/-Users-Martin-Tresors-Projects-GenesisTools/...
	const projectDir = filePath.replace(PROJECTS_DIR + "/", "").split("/")[0];
	// Convert -Users-Martin-Tresors-Projects-GenesisTools to GenesisTools
	const parts = projectDir.split("-");
	return parts[parts.length - 1] || projectDir;
}

// =============================================================================
// JSONL Parsing
// =============================================================================

export async function parseJsonlFile(filePath: string): Promise<ConversationMessage[]> {
	const messages: ConversationMessage[] = [];

	const fileStream = createReadStream(filePath);
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		if (line.trim()) {
			try {
				const parsed = JSON.parse(line) as ConversationMessage;
				messages.push(parsed);
			} catch {
				// Skip invalid JSON lines
			}
		}
	}

	return messages;
}

// =============================================================================
// Text Extraction & Matching
// =============================================================================

export function extractTextFromMessage(message: ConversationMessage, excludeThinking: boolean): string {
	const texts: string[] = [];

	if (message.type === "user") {
		const userMsg = message as UserMessage;
		if (typeof userMsg.message.content === "string") {
			texts.push(userMsg.message.content);
		} else if (Array.isArray(userMsg.message.content)) {
			for (const block of userMsg.message.content) {
				if (block.type === "text") {
					texts.push((block as TextBlock).text);
				} else if (block.type === "tool_result" && typeof block.content === "string") {
					texts.push(block.content);
				}
			}
		}
	} else if (message.type === "assistant") {
		const assistantMsg = message as AssistantMessage;
		if (Array.isArray(assistantMsg.message.content)) {
			for (const block of assistantMsg.message.content) {
				if (block.type === "text") {
					texts.push((block as TextBlock).text);
				} else if (block.type === "thinking" && !excludeThinking) {
					texts.push((block as ThinkingBlock).thinking);
				}
			}
		}
	} else if (message.type === "summary") {
		texts.push((message as SummaryMessage).summary);
	} else if (message.type === "custom-title") {
		texts.push((message as CustomTitleMessage).customTitle);
	} else if (message.type === "queue-operation" && "content" in message) {
		texts.push(message.content as string);
	}

	return texts.join(" ");
}

export function extractToolUses(message: ConversationMessage): ToolUseBlock[] {
	if (message.type !== "assistant") return [];

	const assistantMsg = message as AssistantMessage;
	if (!Array.isArray(assistantMsg.message?.content)) return [];

	return assistantMsg.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function extractFilePaths(message: ConversationMessage): string[] {
	const paths: string[] = [];
	const toolUses = extractToolUses(message);

	for (const tool of toolUses) {
		if (tool.input && typeof tool.input === "object") {
			// Common file path field names
			const fileFields = ["file_path", "path", "filePath"];
			for (const field of fileFields) {
				if (field in tool.input && typeof tool.input[field] === "string") {
					paths.push(tool.input[field] as string);
				}
			}
		}
	}

	return paths;
}

export function matchesQuery(text: string, query: string, exact: boolean, regex: boolean): boolean {
	if (!query) return true;

	if (regex) {
		try {
			const re = new RegExp(query, "i");
			return re.test(text);
		} catch {
			return false;
		}
	}

	if (exact) {
		return text.toLowerCase().includes(query.toLowerCase());
	}

	// Fuzzy match: all words must be present
	const words = query.toLowerCase().split(/\s+/);
	const lowerText = text.toLowerCase();
	return words.every((word) => lowerText.includes(word));
}

/**
 * Calculate relevance score for a search result
 * Higher score = better match
 */
export function calculateRelevanceScore(
	query: string,
	summary: string | undefined,
	customTitle: string | undefined,
	firstUserMessage: string | undefined,
	allText: string,
	timestamp: Date,
): number {
	if (!query) return 0;

	let score = 0;
	const queryWords = query.toLowerCase().split(/\s+/);
	const queryLower = query.toLowerCase();

	// Title/summary exact match (highest weight)
	const titleText = (customTitle || summary || "").toLowerCase();
	if (titleText.includes(queryLower)) {
		score += 100; // Exact phrase in title
	} else {
		// Word matches in title (3x weight)
		for (const word of queryWords) {
			if (titleText.includes(word)) {
				score += 15;
			}
		}
	}

	// First user message match (2x weight)
	if (firstUserMessage) {
		const firstMsgLower = firstUserMessage.toLowerCase();
		if (firstMsgLower.includes(queryLower)) {
			score += 50; // Exact phrase in first message
		} else {
			for (const word of queryWords) {
				if (firstMsgLower.includes(word)) {
					score += 10;
				}
			}
		}
	}

	// General content match (1x weight)
	const allTextLower = allText.toLowerCase();
	for (const word of queryWords) {
		// Count occurrences (capped)
		const occurrences = Math.min((allTextLower.match(new RegExp(word, "gi")) || []).length, 10);
		score += occurrences;
	}

	// Recency bonus (up to 20 points for conversations in last 7 days)
	const daysSinceConversation = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24);
	if (daysSinceConversation < 7) {
		score += Math.round(20 * (1 - daysSinceConversation / 7));
	}

	return score;
}

/**
 * Extract git commit hashes from Bash tool calls in a conversation
 */
export function extractCommitHashes(messages: ConversationMessage[]): string[] {
	const hashes = new Set<string>();
	const commitPattern = /\b([a-f0-9]{7,40})\b/gi;
	const gitCommitPattern = /git commit|committed|Commit:/i;

	for (const msg of messages) {
		if (msg.type === "user") {
			const userMsg = msg as UserMessage;
			if (Array.isArray(userMsg.message.content)) {
				for (const block of userMsg.message.content) {
					if (block.type === "tool_result" && typeof block.content === "string") {
						// Look for commit hashes in tool results
						if (gitCommitPattern.test(block.content)) {
							const matches = block.content.match(commitPattern);
							if (matches) {
								for (const match of matches) {
									// Filter out common false positives (too short or all same char)
									if (match.length >= 7 && !/^(.)\1+$/.test(match)) {
										hashes.add(match);
									}
								}
							}
						}
					}
				}
			}
		} else if (msg.type === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// Look for Bash commands with git commit
			for (const block of assistantMsg.message.content) {
				if (block.type === "tool_use" && block.name === "Bash") {
					const input = block.input as Record<string, unknown>;
					const cmd = (input.command as string) || "";
					if (cmd.includes("git commit")) {
						// The commit hash will be in the tool result
					}
				}
			}
		}
	}

	return [...hashes];
}

function matchesFilters(
	message: ConversationMessage,
	filters: SearchFilters,
	allText: string,
): boolean {
	// Query match
	if (filters.query) {
		if (!matchesQuery(allText, filters.query, !!filters.exact, !!filters.regex)) {
			return false;
		}
	}

	// Tool filter
	if (filters.tool) {
		const toolUses = extractToolUses(message);
		const hasMatchingTool = toolUses.some((t) =>
			t.name.toLowerCase().includes(filters.tool!.toLowerCase()),
		);
		if (!hasMatchingTool) return false;
	}

	// File filter
	if (filters.file) {
		const filePaths = extractFilePaths(message);
		const filePattern = filters.file.toLowerCase();
		const hasMatchingFile = filePaths.some((p) => {
			const lowerPath = p.toLowerCase();
			if (filePattern.includes("*")) {
				// Simple glob matching
				const regex = new RegExp(filePattern.replace(/\*/g, ".*"), "i");
				return regex.test(lowerPath);
			}
			return lowerPath.includes(filePattern);
		});
		if (!hasMatchingFile) return false;
	}

	// Date filters
	if (filters.since || filters.until) {
		const msgTimestamp = "timestamp" in message ? new Date(message.timestamp as string) : null;
		if (msgTimestamp) {
			if (filters.since && msgTimestamp < filters.since) return false;
			if (filters.until && msgTimestamp > filters.until) return false;
		}
	}

	return true;
}

// =============================================================================
// Search Implementation
// =============================================================================

export async function searchConversations(filters: SearchFilters): Promise<SearchResult[]> {
	let results: SearchResult[] = [];
	const files = await findConversationFiles(filters);

	for (const filePath of files) {
		const messages = await parseJsonlFile(filePath);
		if (messages.length === 0) continue;

		const project = extractProjectName(filePath);
		const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

		// Extract metadata
		let summary: string | undefined;
		let customTitle: string | undefined;
		let gitBranch: string | undefined;
		let sessionId: string | undefined;
		let firstTimestamp: Date | undefined;
		let firstUserMessage: string | undefined;

		for (const msg of messages) {
			if (msg.type === "summary") {
				summary = (msg as SummaryMessage).summary;
			}
			if (msg.type === "custom-title") {
				customTitle = (msg as CustomTitleMessage).customTitle;
			}
			if ("gitBranch" in msg && msg.gitBranch) {
				gitBranch = msg.gitBranch as string;
			}
			if ("sessionId" in msg && msg.sessionId) {
				sessionId = msg.sessionId as string;
			}
			if ("timestamp" in msg && msg.timestamp && !firstTimestamp) {
				firstTimestamp = new Date(msg.timestamp as string);
			}
			// Get first user message for relevance scoring
			if (msg.type === "user" && !firstUserMessage) {
				firstUserMessage = extractTextFromMessage(msg, true);
			}
		}

		// Skip current session if requested
		if (filters.excludeCurrentSession && sessionId === filters.excludeCurrentSession) {
			continue;
		}

		// Conversation date filter (based on first message, not individual messages)
		if (filters.conversationDate && firstTimestamp) {
			if (firstTimestamp < filters.conversationDate) continue;
		}
		if (filters.conversationDateUntil && firstTimestamp) {
			if (firstTimestamp > filters.conversationDateUntil) continue;
		}

		// Summary-only search mode
		if (filters.summaryOnly) {
			const titleText = customTitle || summary || "";
			if (filters.query && !matchesQuery(titleText, filters.query, !!filters.exact, !!filters.regex)) {
				continue;
			}
			// For summary-only, we match if the title/summary matches
			results.push({
				filePath,
				project,
				sessionId: sessionId || basename(filePath, ".jsonl"),
				timestamp: firstTimestamp || new Date(),
				summary,
				customTitle,
				gitBranch,
				matchedMessages: [],
				isSubagent,
				relevanceScore: filters.query
					? calculateRelevanceScore(filters.query, summary, customTitle, firstUserMessage, titleText, firstTimestamp || new Date())
					: 0,
			});
			continue;
		}

		// Commit hash search
		if (filters.commitHash) {
			const commitHashes = extractCommitHashes(messages);
			if (!commitHashes.some(h => h.toLowerCase().startsWith(filters.commitHash!.toLowerCase()))) {
				continue;
			}
			results.push({
				filePath,
				project,
				sessionId: sessionId || basename(filePath, ".jsonl"),
				timestamp: firstTimestamp || new Date(),
				summary,
				customTitle,
				gitBranch,
				matchedMessages: messages.filter(m => m.type === "user" || m.type === "assistant"),
				isSubagent,
				commitHashes,
			});
			continue;
		}

		// Commit message search
		if (filters.commitMessage) {
			let foundCommitMsg = false;
			for (const msg of messages) {
				if (msg.type === "assistant") {
					const assistantMsg = msg as AssistantMessage;
					for (const block of assistantMsg.message.content) {
						if (block.type === "tool_use" && block.name === "Bash") {
							const input = block.input as Record<string, unknown>;
							const cmd = (input.command as string) || "";
							if (cmd.includes("git commit") && cmd.toLowerCase().includes(filters.commitMessage.toLowerCase())) {
								foundCommitMsg = true;
								break;
							}
						}
					}
				}
				if (foundCommitMsg) break;
			}
			if (!foundCommitMsg) continue;

			results.push({
				filePath,
				project,
				sessionId: sessionId || basename(filePath, ".jsonl"),
				timestamp: firstTimestamp || new Date(),
				summary,
				customTitle,
				gitBranch,
				matchedMessages: messages.filter(m => m.type === "user" || m.type === "assistant"),
				isSubagent,
				commitHashes: extractCommitHashes(messages),
			});
			continue;
		}

		// Standard search: find matching messages
		const matchedMessages: ConversationMessage[] = [];
		const matchedIndices: number[] = [];
		let allText = "";

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const text = extractTextFromMessage(msg, !!filters.excludeThinking);
			allText += " " + text;

			if (matchesFilters(msg, filters, text)) {
				matchedMessages.push(msg);
				matchedIndices.push(i);
			}
		}

		if (matchedMessages.length > 0 || !filters.query) {
			// Get context messages if requested
			let contextMessages: ConversationMessage[] | undefined;
			if (filters.context && filters.context > 0 && matchedIndices.length > 0) {
				const contextSet = new Set<number>();
				for (const idx of matchedIndices) {
					for (let i = Math.max(0, idx - filters.context); i <= Math.min(messages.length - 1, idx + filters.context); i++) {
						contextSet.add(i);
					}
				}
				const sortedIndices = [...contextSet].sort((a, b) => a - b);
				contextMessages = sortedIndices.map((i) => messages[i]);
			}

			// Calculate relevance score
			const relevanceScore = filters.query
				? calculateRelevanceScore(filters.query, summary, customTitle, firstUserMessage, allText, firstTimestamp || new Date())
				: 0;

			results.push({
				filePath,
				project,
				sessionId: sessionId || basename(filePath, ".jsonl"),
				timestamp: firstTimestamp || new Date(),
				summary,
				customTitle,
				gitBranch,
				matchedMessages,
				contextMessages,
				isSubagent,
				relevanceScore,
			});
		}
	}

	// Sort by relevance if requested, otherwise by date (already sorted by file mtime)
	if (filters.sortByRelevance && filters.query) {
		results.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
	}

	// Apply limit after sorting
	if (filters.limit && results.length > filters.limit) {
		results = results.slice(0, filters.limit);
	}

	return results;
}

/**
 * List conversation summaries (quick overview without full search)
 */
export async function listConversationSummaries(filters: SearchFilters): Promise<SearchResult[]> {
	const results: SearchResult[] = [];
	const files = await findConversationFiles(filters);

	for (const filePath of files) {
		const messages = await parseJsonlFile(filePath);
		if (messages.length === 0) continue;

		const project = extractProjectName(filePath);
		const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

		let summary: string | undefined;
		let customTitle: string | undefined;
		let gitBranch: string | undefined;
		let sessionId: string | undefined;
		let firstTimestamp: Date | undefined;

		for (const msg of messages) {
			if (msg.type === "summary") {
				summary = (msg as SummaryMessage).summary;
			}
			if (msg.type === "custom-title") {
				customTitle = (msg as CustomTitleMessage).customTitle;
			}
			if ("gitBranch" in msg && msg.gitBranch) {
				gitBranch = msg.gitBranch as string;
			}
			if ("sessionId" in msg && msg.sessionId) {
				sessionId = msg.sessionId as string;
			}
			if ("timestamp" in msg && msg.timestamp && !firstTimestamp) {
				firstTimestamp = new Date(msg.timestamp as string);
			}
		}

		// Skip current session if requested
		if (filters.excludeCurrentSession && sessionId === filters.excludeCurrentSession) {
			continue;
		}

		// Conversation date filter
		if (filters.conversationDate && firstTimestamp) {
			if (firstTimestamp < filters.conversationDate) continue;
		}
		if (filters.conversationDateUntil && firstTimestamp) {
			if (firstTimestamp > filters.conversationDateUntil) continue;
		}

		// Skip if no summary/title
		if (!summary && !customTitle) continue;

		results.push({
			filePath,
			project,
			sessionId: sessionId || basename(filePath, ".jsonl"),
			timestamp: firstTimestamp || new Date(),
			summary,
			customTitle,
			gitBranch,
			matchedMessages: [],
			isSubagent,
		});

		if (filters.limit && results.length >= filters.limit) {
			break;
		}
	}

	return results;
}

// =============================================================================
// Metadata Extraction
// =============================================================================

export async function getConversationMetadata(filePath: string): Promise<ConversationMetadata> {
	const messages = await parseJsonlFile(filePath);
	const project = extractProjectName(filePath);
	const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

	let summary: string | undefined;
	let customTitle: string | undefined;
	let gitBranch: string | undefined;
	let sessionId: string | undefined;
	let firstTimestamp: Date | undefined;
	let lastTimestamp: Date | undefined;

	for (const msg of messages) {
		if (msg.type === "summary") {
			summary = (msg as SummaryMessage).summary;
		}
		if (msg.type === "custom-title") {
			customTitle = (msg as CustomTitleMessage).customTitle;
		}
		if ("gitBranch" in msg && msg.gitBranch) {
			gitBranch = msg.gitBranch as string;
		}
		if ("sessionId" in msg && msg.sessionId) {
			sessionId = msg.sessionId as string;
		}
		if ("timestamp" in msg && msg.timestamp) {
			const ts = new Date(msg.timestamp as string);
			if (!firstTimestamp || ts < firstTimestamp) {
				firstTimestamp = ts;
			}
			if (!lastTimestamp || ts > lastTimestamp) {
				lastTimestamp = ts;
			}
		}
	}

	return {
		filePath,
		project,
		sessionId: sessionId || basename(filePath, ".jsonl"),
		firstTimestamp,
		lastTimestamp,
		summary,
		customTitle,
		gitBranch,
		messageCount: messages.length,
		isSubagent,
	};
}

// =============================================================================
// Get All Conversations (for listing)
// =============================================================================

export async function getAllConversations(filters: SearchFilters = {}): Promise<SearchResult[]> {
	const files = await findConversationFiles(filters);
	const results: SearchResult[] = [];

	for (const filePath of files) {
		const messages = await parseJsonlFile(filePath);
		if (messages.length === 0) continue;

		const project = extractProjectName(filePath);
		const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

		let summary: string | undefined;
		let customTitle: string | undefined;
		let gitBranch: string | undefined;
		let sessionId: string | undefined;
		let firstTimestamp: Date | undefined;

		// Count message types
		let userCount = 0;
		let assistantCount = 0;

		for (const msg of messages) {
			if (msg.type === "summary") {
				summary = (msg as SummaryMessage).summary;
			}
			if (msg.type === "custom-title") {
				customTitle = (msg as CustomTitleMessage).customTitle;
			}
			if ("gitBranch" in msg && msg.gitBranch) {
				gitBranch = msg.gitBranch as string;
			}
			if ("sessionId" in msg && msg.sessionId) {
				sessionId = msg.sessionId as string;
			}
			if ("timestamp" in msg && msg.timestamp && !firstTimestamp) {
				firstTimestamp = new Date(msg.timestamp as string);
			}
			if (msg.type === "user") userCount++;
			if (msg.type === "assistant") assistantCount++;
		}

		results.push({
			filePath,
			project,
			sessionId: sessionId || basename(filePath, ".jsonl"),
			timestamp: firstTimestamp || new Date(),
			summary,
			customTitle,
			gitBranch,
			matchedMessages: messages.filter(m => m.type === "user" || m.type === "assistant"),
			isSubagent,
		});

		if (filters.limit && results.length >= filters.limit) {
			break;
		}
	}

	return results;
}

// =============================================================================
// Get Available Projects
// =============================================================================

export async function getAvailableProjects(): Promise<string[]> {
	const dirs = await glob(`${PROJECTS_DIR}/*/`, { absolute: true });
	return [...new Set(dirs.map((d) => extractProjectName(d)))].sort();
}

// =============================================================================
// Get Conversation by Session ID
// =============================================================================

export async function getConversationBySessionId(sessionId: string): Promise<SearchResult | null> {
	// Find all files and look for matching session
	const files = await findConversationFiles({});

	for (const filePath of files) {
		const fileName = basename(filePath, ".jsonl");
		if (fileName === sessionId || filePath.includes(sessionId)) {
			const messages = await parseJsonlFile(filePath);
			if (messages.length === 0) continue;

			const project = extractProjectName(filePath);
			const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

			let summary: string | undefined;
			let customTitle: string | undefined;
			let gitBranch: string | undefined;
			let foundSessionId: string | undefined;
			let firstTimestamp: Date | undefined;

			for (const msg of messages) {
				if (msg.type === "summary") {
					summary = (msg as SummaryMessage).summary;
				}
				if (msg.type === "custom-title") {
					customTitle = (msg as CustomTitleMessage).customTitle;
				}
				if ("gitBranch" in msg && msg.gitBranch) {
					gitBranch = msg.gitBranch as string;
				}
				if ("sessionId" in msg && msg.sessionId) {
					foundSessionId = msg.sessionId as string;
				}
				if ("timestamp" in msg && msg.timestamp && !firstTimestamp) {
					firstTimestamp = new Date(msg.timestamp as string);
				}
			}

			return {
				filePath,
				project,
				sessionId: foundSessionId || fileName,
				timestamp: firstTimestamp || new Date(),
				summary,
				customTitle,
				gitBranch,
				matchedMessages: messages,
				isSubagent,
			};
		}
	}

	return null;
}

// =============================================================================
// Statistics
// =============================================================================

export interface ConversationStats {
	totalConversations: number;
	totalMessages: number;
	projectCounts: Record<string, number>;
	toolCounts: Record<string, number>;
	dailyActivity: Record<string, number>;
	subagentCount: number;
}

export async function getConversationStats(): Promise<ConversationStats> {
	const files = await findConversationFiles({});

	const stats: ConversationStats = {
		totalConversations: 0,
		totalMessages: 0,
		projectCounts: {},
		toolCounts: {},
		dailyActivity: {},
		subagentCount: 0,
	};

	for (const filePath of files) {
		const messages = await parseJsonlFile(filePath);
		if (messages.length === 0) continue;

		stats.totalConversations++;
		stats.totalMessages += messages.length;

		const project = extractProjectName(filePath);
		stats.projectCounts[project] = (stats.projectCounts[project] || 0) + 1;

		const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");
		if (isSubagent) stats.subagentCount++;

		for (const msg of messages) {
			// Track daily activity
			if ("timestamp" in msg && msg.timestamp) {
				const date = new Date(msg.timestamp as string).toISOString().split("T")[0];
				stats.dailyActivity[date] = (stats.dailyActivity[date] || 0) + 1;
			}

			// Track tool usage
			const toolUses = extractToolUses(msg);
			for (const tool of toolUses) {
				stats.toolCounts[tool.name] = (stats.toolCounts[tool.name] || 0) + 1;
			}
		}
	}

	return stats;
}

// =============================================================================
// Date Parsing Helper
// =============================================================================

export function parseDate(dateStr: string): Date {
	const now = new Date();

	// Relative dates
	const relativeMatch = dateStr.match(/^(\d+)\s*(day|week|month|hour|minute)s?\s*ago$/i);
	if (relativeMatch) {
		const amount = parseInt(relativeMatch[1], 10);
		const unit = relativeMatch[2].toLowerCase();
		const result = new Date(now);

		switch (unit) {
			case "minute":
				result.setMinutes(result.getMinutes() - amount);
				break;
			case "hour":
				result.setHours(result.getHours() - amount);
				break;
			case "day":
				result.setDate(result.getDate() - amount);
				break;
			case "week":
				result.setDate(result.getDate() - amount * 7);
				break;
			case "month":
				result.setMonth(result.getMonth() - amount);
				break;
		}
		return result;
	}

	// Named dates
	if (dateStr.toLowerCase() === "yesterday") {
		const result = new Date(now);
		result.setDate(result.getDate() - 1);
		result.setHours(0, 0, 0, 0);
		return result;
	}

	if (dateStr.toLowerCase() === "today") {
		const result = new Date(now);
		result.setHours(0, 0, 0, 0);
		return result;
	}

	// ISO date or other formats
	return new Date(dateStr);
}
