/**
 * Claude Code Conversation History Library
 * Reusable functions for searching and parsing conversation history
 */

import { glob } from "glob";
import { homedir } from "os";
import { resolve, basename, sep } from "path";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
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
/**
 * Locate matching conversation JSONL files under the projects directory according to the provided search filters.
 *
 * @param filters - Search options that may include a target `project` (exact name or `"all"`), `agentsOnly` to restrict results to subagent/agent files, and `excludeAgents` to omit subagent/agent files; other filter fields are ignored by this function.
 * @returns An array of absolute file paths to matching `.jsonl` conversation files, ordered by modification time with the most recently modified first.
 */

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
			const fileStat = await stat(f);
			return { path: f, mtime: fileStat.mtime };
		}),
	);
	fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

	return fileStats.map((f) => f.path);
}

/**
 * Derives a human-friendly project name from a conversation file path.
 *
 * @param filePath - Full path to a conversation file located under PROJECTS_DIR
 * @returns The extracted project name (the last hyphen-separated segment of the project directory), e.g. `GenesisTools`
 */
export function extractProjectName(filePath: string): string {
	// Extract project name from path like:
	// /Users/Martin/.claude/projects/-Users-Martin-Tresors-Projects-GenesisTools/...
	const projectDir = filePath.replace(PROJECTS_DIR + sep, "").split(sep)[0];
	// Convert -Users-Martin-Tresors-Projects-GenesisTools to GenesisTools
	const parts = projectDir.split("-");
	return parts[parts.length - 1] || projectDir;
}

// =============================================================================
// JSONL Parsing
/**
 * Reads a JSONL file and parses each non-empty line into a list of ConversationMessage objects.
 *
 * @param filePath - Path to the JSONL file to read.
 * @returns An array of parsed ConversationMessage objects; empty lines and lines that fail JSON parsing are skipped.
 */

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
/**
 * Extracts searchable text content from a conversation message.
 *
 * Includes text from user, assistant, summary, custom-title, and queue-operation messages;
 * when `excludeThinking` is true, assistant "thinking" blocks are omitted.
 *
 * @param message - The conversation message to extract text from
 * @param excludeThinking - If true, omit assistant "thinking" blocks from the result
 * @returns The message's concatenated textual content
 */

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

/**
 * Extracts tool usage blocks from an assistant message.
 *
 * @param message - The conversation message to inspect
 * @returns An array of `ToolUseBlock` objects present in the assistant message's content, or an empty array if the message is not an assistant message or contains no `tool_use` blocks
 */
export function extractToolUses(message: ConversationMessage): ToolUseBlock[] {
	if (message.type !== "assistant") return [];

	const assistantMsg = message as AssistantMessage;
	if (!Array.isArray(assistantMsg.message?.content)) return [];

	return assistantMsg.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/**
 * Extracts file-related paths referenced in any `tool_use` blocks of a conversation message.
 *
 * Scans tool use inputs for common file path fields (`file_path`, `path`, `filePath`) and returns all matching string values.
 *
 * @param message - The conversation message to inspect for tool use blocks
 * @returns An array of file path strings found in the message's tool use blocks (empty if none)
 */
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

/**
 * Determine whether a regex pattern is safe for use by guarding against common ReDoS vectors.
 *
 * Patterns longer than 200 characters or containing nested quantifiers (e.g., repeated quantifier sequences) are considered unsafe.
 *
 * @returns `true` if the pattern passes the safety checks, `false` otherwise.
 */
function isSafeRegex(pattern: string): boolean {
	// Reject excessively long patterns
	if (pattern.length > 200) return false;
	// Reject patterns with nested quantifiers (e.g., (a+)+ or (a*)*b*)
	const nestedQuantifiers = /(\+|\*|\?|\{[\d,]+\})\s*\)?\s*(\+|\*|\?|\{[\d,]+\})/;
	if (nestedQuantifiers.test(pattern)) return false;
	return true;
}

/**
 * Determine whether the provided text matches the query according to the selected matching mode.
 *
 * @param text - The text to search within.
 * @param query - The search query; an empty query matches all text.
 * @param exact - If true, perform a case-insensitive substring match.
 * @param regex - If true, treat `query` as a case-insensitive regular expression; unsafe patterns are rejected.
 * @returns `true` if `text` satisfies the query under the selected mode, `false` otherwise.
 */
export function matchesQuery(text: string, query: string, exact: boolean, regex: boolean): boolean {
	if (!query) return true;

	if (regex) {
		if (!isSafeRegex(query)) {
			return false; // Reject potentially dangerous patterns
		}
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
 * Compute a relevance score for a conversation against a search query.
 *
 * @returns A numeric relevance score where higher values indicate a better match; `0` when `query` is empty.
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

	// General content match (1x weight) - use string matching to avoid ReDoS
	const allTextLower = allText.toLowerCase();
	for (const word of queryWords) {
		// Count occurrences (capped) using safe string matching
		const wordLower = word.toLowerCase();
		let occurrences = 0;
		let pos = 0;
		while ((pos = allTextLower.indexOf(wordLower, pos)) !== -1 && occurrences < 10) {
			occurrences++;
			pos += wordLower.length;
		}
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
 * Find unique Git commit hashes referenced in a conversation's Bash/tool outputs.
 *
 * Scans user tool results and assistant Bash tool usages for hexadecimal hashes that
 * represent Git commits.
 *
 * @param messages - Array of conversation messages to scan
 * @returns Unique commit hashes composed of 7 to 40 hexadecimal characters; excludes hashes shorter than 7 characters and sequences made of the same repeated character
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

/**
 * Determines whether a message meets the provided search filters.
 *
 * Evaluates active filters (query, tool, file, since, until) against the given message and its searchable text and returns whether the message satisfies all of them.
 *
 * @param message - The conversation message to test
 * @param filters - Search filters to apply; only active (non-empty) fields are considered
 * @param allText - Concatenated searchable text for the message (e.g., title, summary, and message content)
 * @returns `true` if the message satisfies all active filters, `false` otherwise.
 */
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
				// Simple glob matching - escape regex metacharacters first, then convert * to .*
				const regexPattern = filePattern
					.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*");
				if (!isSafeRegex(regexPattern)) return false;
				try {
					const regex = new RegExp(regexPattern, "i");
					return regex.test(lowerPath);
				} catch {
					return false;
				}
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
/**
 * Search conversation JSONL files and return conversations that match the provided filters.
 *
 * Supports multiple search modes (summary-only, commit-hash, commit-message, and standard full-text),
 * optional context around matched messages, relevance scoring, project/date/tool/file filters, and limits/sorting.
 *
 * @param filters - SearchFilters specifying query text, project and date constraints, tools/files, search mode flags (e.g., `summaryOnly`, `commitHash`, `commitMessage`), context size, relevance sorting, exclusion of the current session, and result limits.
 * @returns An array of SearchResult objects for conversations that satisfy the filters. Each result contains conversation metadata (filePath, project, sessionId, timestamps, summary/customTitle, gitBranch, isSubagent), matchedMessages, optional contextMessages, and a relevanceScore when a query was provided.

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
 * Collects lightweight summaries for conversations matching the provided filters.
 *
 * Filters supported (from `SearchFilters`): `excludeCurrentSession` (omits a matching sessionId),
 * `conversationDate` and `conversationDateUntil` (inclusive date range applied to the conversation's first message),
 * and `limit` (maximum number of summaries to return). Conversations without a `summary` or `customTitle` are skipped.
 *
 * @param filters - Criteria to select which conversation files to include
 * @returns An array of summary objects each containing `filePath`, `project`, `sessionId`, `timestamp`, `summary`, `customTitle`, `gitBranch`, `matchedMessages` (empty), and `isSubagent`
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
/**
 * Collects aggregated metadata for a conversation file.
 *
 * Scans the file's messages to extract project name, session ID, summary, custom title, Git branch, first and last message timestamps, message count, and whether the file represents a subagent.
 *
 * @param filePath - Path to the conversation JSONL file
 * @returns A ConversationMetadata object containing:
 *  - `filePath`: the input path
 *  - `project`: inferred project name
 *  - `sessionId`: session identifier (from messages or filename)
 *  - `firstTimestamp` / `lastTimestamp`: earliest and latest message timestamps when available
 *  - `summary`: conversation summary message if present
 *  - `customTitle`: custom title message if present
 *  - `gitBranch`: git branch value if present in messages
 *  - `messageCount`: total number of parsed messages
 *  - `isSubagent`: true when the file path indicates a subagent conversation
 */

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
/**
 * Collects metadata and basic contents for all conversations that match the provided filters.
 *
 * @param filters - Optional filters to restrict which conversations are included (e.g., project, date range, agent inclusion/exclusion, or `limit`).
 * @returns An array of conversation summaries where each entry contains:
 * - `filePath` and derived `project`
 * - `sessionId` (from messages or filename)
 * - `timestamp` (first message timestamp or current time)
 * - optional `summary`, `customTitle`, and `gitBranch`
 * - `matchedMessages` (only user and assistant messages)
 * - `isSubagent` flag
 * - `userMessageCount` and `assistantMessageCount`
 */

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
			userMessageCount: userCount,
			assistantMessageCount: assistantCount,
		});

		if (filters.limit && results.length >= filters.limit) {
			break;
		}
	}

	return results;
}

// =============================================================================
// Get Available Projects
/**
 * Lists all available project names discovered under the configured projects directory.
 *
 * @returns A sorted array of unique, human-friendly project names found in PROJECTS_DIR
 */

export async function getAvailableProjects(): Promise<string[]> {
	// Use forward slash in glob pattern (glob normalizes paths)
	const dirs = await glob(`${PROJECTS_DIR}/*/`, { absolute: true });
	// extractProjectName handles OS-native separators from absolute paths
	return [...new Set(dirs.map((d) => extractProjectName(d)))].sort();
}

// =============================================================================
// Get Conversation by Session ID
/**
 * Locate and return the conversation that corresponds to a given session ID.
 *
 * Searches conversation files for a matching session by comparing the file basename or any substring of the file path to `sessionId`, and returns the conversation's metadata and all messages when found.
 *
 * @param sessionId - Session identifier to match against the conversation file name or path
 * @returns A SearchResult containing metadata and all messages for the matched conversation, or `null` if no match is found
 */

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

/**
 * Aggregates global statistics across all discovered conversation files.
 *
 * Collects totals and distributions by scanning each conversation JSONL file: counts conversations and messages, tallies conversations per project, counts tool usages, records per-day message activity, and counts conversations identified as subagents.
 *
 * @returns An object containing:
 * - `totalConversations`: total number of conversation files with at least one message
 * - `totalMessages`: total number of messages across all conversations
 * - `projectCounts`: map from project name to number of conversations in that project
 * - `toolCounts`: map from tool name to number of times that tool was used
 * - `dailyActivity`: map from ISO date (YYYY-MM-DD) to number of messages on that date
 * - `subagentCount`: number of conversations identified as subagents
 */
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
/**
 * Parse a human-friendly date string into a Date.
 *
 * Supports relative forms like "3 days ago", "2 weeks ago", "5 months ago",
 * "4 hours ago", and "30 minutes ago"; the named values "yesterday" and
 * "today" (both normalized to local midnight); and ISO or other formats
 * accepted by the JavaScript Date constructor as a fallback.
 *
 * @param dateStr - The input date string to parse.
 * @returns A Date representing the parsed time (relative times are computed
 *          from now; "yesterday" and "today" are set to local 00:00).

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