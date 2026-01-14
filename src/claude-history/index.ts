#!/usr/bin/env bun
import { program } from "commander";
import { search } from "@inquirer/prompts";
import select from "@inquirer/select";
import input from "@inquirer/input";
import { glob } from "glob";
import { homedir } from "os";
import { resolve, basename } from "path";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import chalk from "chalk";
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
} from "./types";

const CLAUDE_DIR = resolve(homedir(), ".claude");
const PROJECTS_DIR = resolve(CLAUDE_DIR, "projects");

// =============================================================================
// File Discovery
// =============================================================================

async function findConversationFiles(filters: SearchFilters): Promise<string[]> {
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

function extractProjectName(filePath: string): string {
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

async function parseJsonlFile(filePath: string): Promise<ConversationMessage[]> {
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

function extractTextFromMessage(message: ConversationMessage, excludeThinking: boolean): string {
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

function extractToolUses(message: ConversationMessage): ToolUseBlock[] {
	if (message.type !== "assistant") return [];

	const assistantMsg = message as AssistantMessage;
	if (!Array.isArray(assistantMsg.message?.content)) return [];

	return assistantMsg.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

function extractFilePaths(message: ConversationMessage): string[] {
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

function matchesQuery(text: string, query: string, exact: boolean, regex: boolean): boolean {
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

async function searchConversations(filters: SearchFilters): Promise<SearchResult[]> {
	const results: SearchResult[] = [];
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

		// Find matching messages
		const matchedMessages: ConversationMessage[] = [];
		const matchedIndices: number[] = [];

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const text = extractTextFromMessage(msg, !!filters.excludeThinking);

			if (matchesFilters(msg, filters, text)) {
				matchedMessages.push(msg);
				matchedIndices.push(i);
			}
		}

		if (matchedMessages.length > 0) {
			// Get context messages if requested
			let contextMessages: ConversationMessage[] | undefined;
			if (filters.context && filters.context > 0) {
				const contextSet = new Set<number>();
				for (const idx of matchedIndices) {
					for (let i = Math.max(0, idx - filters.context); i <= Math.min(messages.length - 1, idx + filters.context); i++) {
						contextSet.add(i);
					}
				}
				const sortedIndices = [...contextSet].sort((a, b) => a - b);
				contextMessages = sortedIndices.map((i) => messages[i]);
			}

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
			});
		}

		// Check limit
		if (filters.limit && results.length >= filters.limit) {
			break;
		}
	}

	return results;
}

// =============================================================================
// Output Formatting
// =============================================================================

function formatMessageForMarkdown(msg: ConversationMessage, _excludeThinking: boolean): string {
	const lines: string[] = [];

	if (msg.type === "user") {
		const userMsg = msg as UserMessage;
		let content = "";
		if (typeof userMsg.message.content === "string") {
			content = userMsg.message.content;
		} else if (Array.isArray(userMsg.message.content)) {
			const textBlocks = userMsg.message.content
				.filter((b): b is TextBlock => b.type === "text")
				.map((b) => b.text);
			content = textBlocks.join("\n");
		}
		// Truncate long content
		if (content.length > 500) {
			content = content.substring(0, 500) + "...";
		}
		lines.push(`**[User]** ${content.replace(/\n/g, " ").trim()}`);
	} else if (msg.type === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const textBlocks = assistantMsg.message.content
			.filter((b): b is TextBlock => b.type === "text")
			.map((b) => b.text);
		const toolUses = assistantMsg.message.content.filter(
			(b): b is ToolUseBlock => b.type === "tool_use",
		);

		let text = textBlocks.join("\n").trim();
		if (text.length > 500) {
			text = text.substring(0, 500) + "...";
		}

		lines.push(`**[Assistant]** ${text.replace(/\n/g, " ").trim() || "(tool calls only)"}`);

		if (toolUses.length > 0) {
			for (const tool of toolUses) {
				const filePath =
					tool.input && typeof tool.input === "object"
						? (tool.input as Record<string, unknown>).file_path ||
							(tool.input as Record<string, unknown>).path ||
							""
						: "";
				if (filePath) {
					lines.push(`  - **Tool:** ${tool.name} \`${filePath}\``);
				} else {
					lines.push(`  - **Tool:** ${tool.name}`);
				}
			}
		}
	}

	return lines.join("\n");
}

function formatResultsAsMarkdown(results: SearchResult[], filters: SearchFilters): string {
	const lines: string[] = [];

	const queryDesc = filters.query ? `"${filters.query}"` : "all";
	lines.push(`## Found ${results.length} conversation${results.length !== 1 ? "s" : ""} matching ${queryDesc}\n`);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const title = result.customTitle || result.summary || result.sessionId;
		const date = result.timestamp.toISOString().split("T")[0];

		lines.push(`### ${i + 1}. ${title} (${result.project})${result.isSubagent ? " [Subagent]" : ""}`);
		lines.push(`**Date:** ${date}${result.gitBranch ? ` | **Branch:** ${result.gitBranch}` : ""}`);

		if (result.summary && result.summary !== title) {
			lines.push(`**Summary:** ${result.summary}`);
		}

		lines.push(`**File:** \`${result.filePath.replace(homedir(), "~")}\``);

		// Show context if requested
		if (filters.context && result.contextMessages) {
			lines.push("");
			lines.push(`#### Context (${filters.context} messages before/after match)\n`);
			for (const msg of result.contextMessages) {
				const formatted = formatMessageForMarkdown(msg, !!filters.excludeThinking);
				if (formatted) {
					lines.push(formatted);
					lines.push("");
				}
			}
		}

		lines.push("");
	}

	return lines.join("\n");
}

function formatResultsAsJson(results: SearchResult[]): string {
	return JSON.stringify(results, null, 2);
}

// =============================================================================
// Date Parsing
// =============================================================================

function parseDate(dateStr: string): Date {
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

// =============================================================================
// Interactive Mode
// =============================================================================

async function getAvailableProjects(): Promise<string[]> {
	const dirs = await glob(`${PROJECTS_DIR}/*/`, { absolute: true });
	return dirs.map((d) => extractProjectName(d));
}

async function runInteractive(): Promise<SearchFilters> {
	const projects = await getAvailableProjects();

	const project = await search({
		message: "Select project (type to filter):",
		source: async (term) => {
			const filtered = term
				? projects.filter((p) => p.toLowerCase().includes(term.toLowerCase()))
				: projects;
			return [{ value: "all", name: "All projects" }, ...filtered.map((p) => ({ value: p, name: p }))];
		},
	});

	const query = await input({
		message: "Search query (leave empty for all):",
	});

	const toolChoice = await select({
		message: "Filter by tool?",
		choices: [
			{ value: "", name: "No filter" },
			{ value: "Edit", name: "Edit" },
			{ value: "Write", name: "Write" },
			{ value: "Read", name: "Read" },
			{ value: "Bash", name: "Bash" },
			{ value: "Task", name: "Task" },
			{ value: "Grep", name: "Grep" },
			{ value: "Glob", name: "Glob" },
		],
	});

	const sinceStr = await input({
		message: "Since (e.g., '7 days ago', 'yesterday', or date):",
		default: "",
	});

	const contextStr = await input({
		message: "Context lines (0 for summary only):",
		default: "0",
	});

	return {
		project: project === "all" ? undefined : project,
		query: query || undefined,
		tool: toolChoice || undefined,
		since: sinceStr ? parseDate(sinceStr) : undefined,
		context: parseInt(contextStr, 10) || undefined,
		limit: 20,
	};
}

// =============================================================================
// CLI Setup
// =============================================================================

program
	.name("claude-history")
	.description("Search Claude Code conversation history")
	.argument("[query]", "Search query (fuzzy match by default)")
	.option("-i, --interactive", "Interactive mode with prompts")
	.option("-p, --project <name>", "Filter by project name")
	.option("--all", "Search all projects (ignore cwd)")
	.option("-f, --file <pattern>", "Filter by file path pattern")
	.option("-t, --tool <name>", "Filter by tool name (Edit, Write, Bash, etc.)")
	.option("--since <date>", "Filter by date (e.g., '7 days ago', 'yesterday')")
	.option("--until <date>", "Filter until date")
	.option("-l, --limit <n>", "Limit results", "20")
	.option("-c, --context <n>", "Show N messages before/after match", "0")
	.option("--exact", "Exact match instead of fuzzy")
	.option("--regex", "Use regex for query")
	.option("--agents-only", "Only search subagent conversations")
	.option("--exclude-agents", "Exclude subagent conversations")
	.option("--exclude-thinking", "Exclude thinking blocks from search")
	.option("--format <type>", "Output format: ai (default), json", "ai")
	.action(async (query, options) => {
		try {
			let filters: SearchFilters;

			if (options.interactive) {
				filters = await runInteractive();
			} else {
				// Auto-detect project from cwd
				let project = options.project;
				if (!project && !options.all) {
					const cwd = process.cwd();
					const cwdParts = cwd.split("/");
					// Try to find project name from cwd
					const projectIndex = cwdParts.findIndex((p) => p === "Projects" || p === "projects");
					if (projectIndex !== -1 && cwdParts[projectIndex + 1]) {
						project = cwdParts[projectIndex + 1];
						console.log(chalk.dim(`Auto-detected project: ${project} (use --all to search all projects)`));
					}
				}

				filters = {
					query,
					project: options.all ? undefined : project,
					file: options.file,
					tool: options.tool,
					since: options.since ? parseDate(options.since) : undefined,
					until: options.until ? parseDate(options.until) : undefined,
					limit: parseInt(options.limit, 10),
					context: parseInt(options.context, 10),
					exact: options.exact,
					regex: options.regex,
					agentsOnly: options.agentsOnly,
					excludeAgents: options.excludeAgents,
					excludeThinking: options.excludeThinking,
				};
			}

			const results = await searchConversations(filters);

			if (results.length === 0) {
				console.log(chalk.yellow("No conversations found matching your criteria."));
				return;
			}

			if (options.format === "json") {
				console.log(formatResultsAsJson(results));
			} else {
				console.log(formatResultsAsMarkdown(results, filters));
			}
		} catch (error) {
			if ((error as Error).message?.includes("canceled")) {
				console.log(chalk.dim("\nOperation cancelled."));
				process.exit(0);
			}
			throw error;
		}
	});

program.parse();
