/**
 * ClaudeSession — Fully-typed wrapper around a Claude Code JSONL session file.
 *
 * Provides structured access to session metadata, messages, content extraction,
 * filtering, statistics, and LLM-ready prompt preparation.
 *
 * @example
 * ```ts
 * const session = await ClaudeSession.fromFile("~/.claude/projects/.../abc.jsonl");
 * console.log(session.title, session.stats.toolCallCount);
 * const prepared = session.toPromptContent({ tokenBudget: 8000, priority: "balanced" });
 * ```
 */

import { existsSync, readdirSync } from "fs";
import { stat } from "fs/promises";
import { glob } from "glob";
import { basename, resolve, sep } from "path";
import { estimateTokens } from "../tokens";
import { parseJsonlTranscript, PROJECTS_DIR, encodedProjectDir } from "./index";
import type {
    AssistantMessage,
    AssistantMessageContent,
    ContentBlock,
    ConversationMessage,
    CustomTitleMessage,
    ImageBlock,
    MessageType,
    PrLinkMessage,
    ProgressMessage,
    SubagentMessage,
    SummaryMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolReferenceBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
    UserMessage,
    UserMessageContent,
} from "./types";

// =============================================================================
// Exported Interface Types
// =============================================================================

/** Options for extracting plain text from session messages. */
export interface ExtractTextOptions {
    /** Include tool result content in the extracted text. Default: false */
    includeToolResults?: boolean;
    /** Include thinking/reasoning blocks. Default: false */
    includeThinking?: boolean;
    /** Include system messages (errors, stop hooks). Default: false */
    includeSystemMessages?: boolean;
    /** Prefix tool calls with their name (e.g. "[Edit]"). Default: true */
    includeToolNames?: boolean;
    /** Maximum character length for the returned string. */
    maxLength?: number;
}

/** Options for preparing session content for an LLM prompt. */
export interface PromptContentOptions {
    /** Maximum token budget for the prepared content. */
    tokenBudget: number;
    /** Content selection strategy when the session exceeds the budget. */
    priority: "balanced" | "user-first" | "assistant-first";
    /** Include tool result blocks. Default: false */
    includeToolResults?: boolean;
    /** Include thinking/reasoning blocks. Default: false */
    includeThinking?: boolean;
    /** Prefix each message with its ISO timestamp. Default: false */
    includeTimestamps?: boolean;
}

/** Result of `toPromptContent()` — token-budgeted session transcript. */
export interface PreparedContent {
    /** The formatted transcript string. */
    content: string;
    /** Estimated token count of `content`. */
    tokenCount: number;
    /** Whether the content was truncated to fit the budget. */
    truncated: boolean;
    /** Human-readable description of what was truncated. */
    truncationInfo: string;
    /** Summary statistics for the prepared content. */
    stats: {
        userMessages: number;
        assistantMessages: number;
        toolCalls: number;
        filesModified: string[];
    };
}

/** Aggregated statistics for a session. */
export interface SessionStats {
    /** Total number of JSONL entries (all types). */
    messageCount: number;
    /** Number of user-role messages. */
    userMessageCount: number;
    /** Number of assistant-role messages. */
    assistantMessageCount: number;
    /** Number of system messages (errors, stop hooks, etc.). */
    systemMessageCount: number;
    /** Number of subagent messages. */
    subagentMessageCount: number;
    /** Number of progress messages. */
    progressMessageCount: number;
    /** Number of PR link messages. */
    prLinkCount: number;
    /** Total number of tool_use blocks across all assistant and subagent messages. */
    toolCallCount: number;
    /** Tool name -> invocation count. */
    toolUsage: Record<string, number>;
    /** Aggregated API token usage from assistant message metadata. */
    tokenUsage: { input: number; output: number; cached: number };
    /** Distinct model IDs seen in assistant messages. */
    modelsUsed: string[];
    /** Unique file paths referenced in tool calls. */
    filesModified: string[];
    /** Duration in milliseconds between first and last timestamp. */
    duration: number;
    /** Earliest message timestamp. */
    firstTimestamp: Date | null;
    /** Latest message timestamp. */
    lastTimestamp: Date | null;
}

/** Lightweight metadata for a discovered session file (no full parse). */
export interface SessionInfo {
    filePath: string;
    sessionId: string | null;
    title: string | null;
    summary: string | null;
    gitBranch: string | null;
    project: string | null;
    startDate: Date | null;
    fileSize: number;
    messageCount: number;
    isSubagent: boolean;
}

/** Options for `ClaudeSession.findSessions()`. */
export interface SessionDiscoveryOptions {
    /** Project name (directory basename) to scope to. */
    project?: string;
    /** Only include sessions starting on or after this date. */
    since?: Date;
    /** Only include sessions starting on or before this date. */
    until?: Date;
    /** Include subagent sessions. Default: false */
    includeSubagents?: boolean;
    /** Maximum number of sessions to return. */
    limit?: number;
}

/** Summary of a single tool invocation. */
export interface ToolCallSummary {
    /** Tool name (e.g. "Edit", "Bash"). */
    name: string;
    /** Full input object passed to the tool. */
    input: Record<string, unknown>;
    /** File path argument, if the tool accepts one. */
    filePath?: string;
    /** ISO timestamp of the parent message (if available). */
    timestamp?: string;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/** Type guard for messages that carry a timestamp field. */
function hasTimestamp(msg: ConversationMessage): msg is ConversationMessage & { timestamp: string } {
    return "timestamp" in msg && typeof (msg as unknown as { timestamp: unknown }).timestamp === "string";
}

/** Type guard for messages that carry a sessionId field. */
function hasSessionId(msg: ConversationMessage): msg is ConversationMessage & { sessionId: string } {
    return "sessionId" in msg && typeof (msg as unknown as { sessionId: unknown }).sessionId === "string";
}

/** Type guard for messages with gitBranch. */
function hasGitBranch(msg: ConversationMessage): msg is ConversationMessage & { gitBranch: string } {
    return "gitBranch" in msg && typeof (msg as unknown as { gitBranch: unknown }).gitBranch === "string";
}

/** Type guard for messages with cwd. */
function hasCwd(msg: ConversationMessage): msg is ConversationMessage & { cwd: string } {
    return "cwd" in msg && typeof (msg as unknown as { cwd: unknown }).cwd === "string";
}

/** Extract readable text from a single user message content field. */
function extractUserText(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const block of content) {
        if (block.type === "text") {
            parts.push((block as TextBlock).text);
        } else if (block.type === "tool_result") {
            const tr = block as ToolResultBlock;
            if (typeof tr.content === "string") {
                parts.push(tr.content);
            } else if (Array.isArray(tr.content)) {
                for (const inner of tr.content) {
                    if (inner.type === "text") parts.push((inner as TextBlock).text);
                    else if (inner.type === "image") parts.push(`[Image: ${(inner as ImageBlock).source.media_type}]`);
                    else if (inner.type === "tool_reference") parts.push(`[Tool Reference: ${(inner as ToolReferenceBlock).tool_name}]`);
                }
            }
        } else if (block.type === "image") {
            parts.push(`[Image: ${(block as ImageBlock).source.media_type}]`);
        } else if (block.type === "tool_reference") {
            parts.push(`[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
        }
    }
    return parts.join("\n");
}

/** Extract tool_use blocks from an assistant message. */
function getToolUseBlocks(msg: AssistantMessage): ToolUseBlock[] {
    if (!Array.isArray(msg.message?.content)) return [];
    return msg.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Extract tool_use blocks from a subagent assistant message. */
function getSubagentToolUseBlocks(msg: SubagentMessage): ToolUseBlock[] {
    if (msg.role !== "assistant") return [];
    const content = (msg.message as AssistantMessageContent).content;
    if (!Array.isArray(content)) return [];
    return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/** Extract file path from a tool input object, checking common field names. */
function extractFilePathFromInput(input: Record<string, unknown>): string | undefined {
    for (const field of ["file_path", "path", "filePath", "notebook_path"]) {
        if (field in input && typeof input[field] === "string") {
            return input[field] as string;
        }
    }
    return undefined;
}

/** Check whether a JSONL file is from a subagent. */
function isSubagentFile(filePath: string): boolean {
    return filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");
}

/**
 * Read just the first N and last N lines from a JSONL file for fast metadata extraction.
 * Uses Bun.file for performance.
 */
async function readHeadTailLines(filePath: string, headCount: number, tailCount: number): Promise<string[]> {
    const text = await Bun.file(filePath).text();
    const allLines = text.split("\n").filter((l) => l.trim());
    if (allLines.length <= headCount + tailCount) return allLines;
    const head = allLines.slice(0, headCount);
    const tail = allLines.slice(-tailCount);
    return [...head, ...tail];
}

// =============================================================================
// ClaudeSession Class
// =============================================================================

/**
 * A fully-typed, immutable wrapper around a Claude Code JSONL session file.
 *
 * Supports metadata access, message filtering, content extraction, statistics,
 * and token-budgeted prompt preparation for LLM consumption.
 */
export class ClaudeSession {
    private readonly _filePath: string;
    private readonly _messages: ConversationMessage[];

    // Lazily computed caches
    private _stats: SessionStats | null = null;
    private _filePathsCache: string[] | null = null;

    private constructor(filePath: string, messages: ConversationMessage[]) {
        this._filePath = filePath;
        this._messages = messages;
    }

    // =========================================================================
    // Construction
    // =========================================================================

    /**
     * Load a session from a JSONL file path.
     * @param filePath Absolute path to the .jsonl session file.
     */
    static async fromFile(filePath: string): Promise<ClaudeSession> {
        const messages = await parseJsonlTranscript<ConversationMessage>(filePath);
        return new ClaudeSession(filePath, messages);
    }

    /**
     * Load a session by its session ID (full UUID or 8-char prefix).
     * Scans the project directory for a matching filename.
     *
     * @param sessionId Full UUID or prefix (minimum 8 characters).
     * @param projectDir Encoded project directory name. Defaults to the current cwd encoding.
     * @throws {Error} If no matching session file is found.
     */
    static async fromSessionId(sessionId: string, projectDir?: string): Promise<ClaudeSession> {
        const dir = projectDir
            ? resolve(PROJECTS_DIR, projectDir)
            : resolve(PROJECTS_DIR, encodedProjectDir());

        if (!existsSync(dir)) {
            throw new Error(`Project directory does not exist: ${dir}`);
        }

        // Try exact match first
        const exactPath = resolve(dir, `${sessionId}.jsonl`);
        if (existsSync(exactPath)) {
            return ClaudeSession.fromFile(exactPath);
        }

        // Prefix search across main dir and subagents
        const dirsToSearch = [dir];
        const subagentsDir = resolve(dir, "subagents");
        if (existsSync(subagentsDir)) {
            dirsToSearch.push(subagentsDir);
        }

        const lowerPrefix = sessionId.toLowerCase();
        for (const searchDir of dirsToSearch) {
            let entries: string[];
            try {
                entries = readdirSync(searchDir);
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.endsWith(".jsonl") && entry.toLowerCase().startsWith(lowerPrefix)) {
                    return ClaudeSession.fromFile(resolve(searchDir, entry));
                }
            }
        }

        throw new Error(`No session file found for ID prefix "${sessionId}" in ${dir}`);
    }

    /**
     * Discover session files matching the given criteria.
     *
     * For performance, only the first and last few lines of each file are parsed
     * to extract metadata — no full JSONL parse is performed.
     *
     * @returns Array of `SessionInfo` sorted by start date (newest first).
     */
    static async findSessions(options: SessionDiscoveryOptions = {}): Promise<SessionInfo[]> {
        const { project, since, until, includeSubagents = false, limit } = options;

        // Determine search directory
        const baseDir = project
            ? resolve(PROJECTS_DIR, encodedProjectDir(project))
            : resolve(PROJECTS_DIR, encodedProjectDir());

        // Build glob patterns
        const patterns: string[] = [];
        if (existsSync(baseDir)) {
            patterns.push(resolve(baseDir, "*.jsonl"));
            if (includeSubagents) {
                patterns.push(resolve(baseDir, "subagents", "*.jsonl"));
            }
        } else if (project) {
            // Fallback: glob for any dir containing the project name
            patterns.push(`${PROJECTS_DIR}/*${project}*/*.jsonl`);
            if (includeSubagents) {
                patterns.push(`${PROJECTS_DIR}/*${project}*/subagents/*.jsonl`);
            }
        }

        if (patterns.length === 0) return [];

        // Discover files
        let files: string[] = [];
        for (const pattern of patterns) {
            const matched = await glob(pattern, { absolute: true });
            files.push(...matched);
        }
        files = [...new Set(files)];

        // Filter out subagent files if not requested
        if (!includeSubagents) {
            files = files.filter((f) => !isSubagentFile(f));
        }

        // Extract lightweight metadata from each file
        const results: SessionInfo[] = [];
        for (const filePath of files) {
            try {
                const fileStat = await stat(filePath);
                const lines = await readHeadTailLines(filePath, 20, 5);

                let sessionId: string | null = null;
                let title: string | null = null;
                let summary: string | null = null;
                let gitBranch: string | null = null;
                let projectName: string | null = null;
                let startDate: Date | null = null;
                let messageCount = 0;

                for (const line of lines) {
                    try {
                        const obj = JSON.parse(line) as Record<string, unknown>;
                        messageCount++;

                        if (obj.type === "custom-title" && typeof obj.customTitle === "string") {
                            title = obj.customTitle;
                        }
                        if (obj.type === "summary" && typeof obj.summary === "string") {
                            summary = obj.summary;
                        }
                        if (typeof obj.sessionId === "string" && !sessionId) {
                            sessionId = obj.sessionId;
                        }
                        if (typeof obj.gitBranch === "string" && !gitBranch) {
                            gitBranch = obj.gitBranch;
                        }
                        if (typeof obj.timestamp === "string" && !startDate) {
                            startDate = new Date(obj.timestamp);
                        }
                    } catch {
                        // Skip unparseable lines
                    }
                }

                // Derive project name from path
                const pathAfterProjects = filePath.replace(PROJECTS_DIR + sep, "");
                const encodedDir = pathAfterProjects.split(sep)[0];
                if (encodedDir) {
                    // Take the last segment of the decoded path as project name
                    const parts = encodedDir.split("-").filter(Boolean);
                    projectName = parts[parts.length - 1] || null;
                }

                // Estimate message count from file size instead of re-reading the whole file.
                // readHeadTailLines already returns all lines for small files.
                // For larger files, estimate ~300 bytes per JSONL line on average.
                if (lines.length <= 25) {
                    // Small file — we already have all lines from readHeadTailLines
                    messageCount = lines.length;
                } else {
                    messageCount = Math.max(lines.length, Math.round(fileStat.size / 300));
                }

                // Apply date filters
                if (since && startDate && startDate < since) continue;
                if (until && startDate && startDate > until) continue;

                results.push({
                    filePath,
                    sessionId: sessionId || basename(filePath, ".jsonl"),
                    title,
                    summary,
                    gitBranch,
                    project: projectName,
                    startDate,
                    fileSize: fileStat.size,
                    messageCount,
                    isSubagent: isSubagentFile(filePath),
                });
            } catch {
                // Skip unreadable files
            }
        }

        // Sort by start date, newest first
        results.sort((a, b) => {
            const ta = a.startDate?.getTime() ?? 0;
            const tb = b.startDate?.getTime() ?? 0;
            return tb - ta;
        });

        return limit ? results.slice(0, limit) : results;
    }

    // =========================================================================
    // Metadata Accessors
    // =========================================================================

    /** The session ID extracted from the first message that carries one, or null. */
    get sessionId(): string | null {
        for (const msg of this._messages) {
            if (hasSessionId(msg)) return msg.sessionId;
        }
        return null;
    }

    /** The custom title set by the user, or null. */
    get title(): string | null {
        for (const msg of this._messages) {
            if (msg.type === "custom-title") {
                return (msg as CustomTitleMessage).customTitle;
            }
        }
        return null;
    }

    /** The auto-generated summary, or null. */
    get summary(): string | null {
        // Take the last summary (Claude may rewrite it)
        let summary: string | null = null;
        for (const msg of this._messages) {
            if (msg.type === "summary") {
                summary = (msg as SummaryMessage).summary;
            }
        }
        return summary;
    }

    /** The git branch recorded in the first message that has one, or null. */
    get gitBranch(): string | null {
        for (const msg of this._messages) {
            if (hasGitBranch(msg)) return msg.gitBranch;
        }
        return null;
    }

    /** The working directory (cwd) recorded in the session, or null. */
    get cwd(): string | null {
        for (const msg of this._messages) {
            if (hasCwd(msg)) return msg.cwd;
        }
        return null;
    }

    /** The project name derived from the file path (last path segment of the decoded cwd). */
    get project(): string | null {
        const pathAfterProjects = this._filePath.replace(PROJECTS_DIR + sep, "");
        const encodedDir = pathAfterProjects.split(sep)[0];
        if (!encodedDir) return null;
        const parts = encodedDir.split("-").filter(Boolean);
        return parts[parts.length - 1] || null;
    }

    /** Timestamp of the first message in the session. */
    get startDate(): Date | null {
        for (const msg of this._messages) {
            if (hasTimestamp(msg)) return new Date(msg.timestamp);
        }
        return null;
    }

    /** Timestamp of the last message in the session. */
    get endDate(): Date | null {
        for (let i = this._messages.length - 1; i >= 0; i--) {
            const msg = this._messages[i];
            if (hasTimestamp(msg)) return new Date(msg.timestamp);
        }
        return null;
    }

    /** Duration in milliseconds between first and last message. */
    get duration(): number {
        const start = this.startDate;
        const end = this.endDate;
        if (!start || !end) return 0;
        return end.getTime() - start.getTime();
    }

    /** Whether this session file comes from a subagent. */
    get isSubagent(): boolean {
        return isSubagentFile(this._filePath);
    }

    /** Absolute path to the JSONL file. */
    get filePath(): string {
        return this._filePath;
    }

    // =========================================================================
    // Message Access
    // =========================================================================

    /** All parsed messages in chronological order. */
    get messages(): ConversationMessage[] {
        return this._messages;
    }

    /** Only user-type messages. */
    get userMessages(): UserMessage[] {
        return this._messages.filter((m): m is UserMessage => m.type === "user");
    }

    /** Only assistant-type messages. */
    get assistantMessages(): AssistantMessage[] {
        return this._messages.filter((m): m is AssistantMessage => m.type === "assistant");
    }

    /** Only system-type messages (errors, stop hooks, etc.). */
    get systemMessages(): SystemMessage[] {
        return this._messages.filter((m): m is SystemMessage => m.type === "system");
    }

    /** Only subagent messages (both user and assistant role). */
    get subagentMessages(): SubagentMessage[] {
        return this._messages.filter((m): m is SubagentMessage => m.type === "subagent");
    }

    /** Only progress messages (real-time updates like bash output, hook status). */
    get progressMessages(): ProgressMessage[] {
        return this._messages.filter((m): m is ProgressMessage => m.type === "progress");
    }

    /** Only PR link messages. */
    get prLinkMessages(): PrLinkMessage[] {
        return this._messages.filter((m): m is PrLinkMessage => m.type === "pr-link");
    }

    // =========================================================================
    // Content Extraction
    // =========================================================================

    /**
     * Extract a plain-text transcript of the session.
     *
     * @param options Control what content types are included.
     * @returns A single string with all extracted text joined by newlines.
     */
    extractText(options: ExtractTextOptions = {}): string {
        const {
            includeToolResults = false,
            includeThinking = false,
            includeSystemMessages = false,
            includeToolNames = true,
            maxLength,
        } = options;

        const parts: string[] = [];

        for (const msg of this._messages) {
            // Skip progress messages — they are noisy real-time updates
            if (msg.type === "progress") continue;

            if (msg.type === "user") {
                const userMsg = msg as UserMessage;
                const text = extractUserText(userMsg.message.content);
                if (text) parts.push(text);
            } else if (msg.type === "assistant") {
                const assistantMsg = msg as AssistantMessage;
                for (const block of assistantMsg.message.content) {
                    if (block.type === "text") {
                        parts.push((block as TextBlock).text);
                    } else if (block.type === "thinking" && includeThinking) {
                        parts.push((block as ThinkingBlock).thinking);
                    } else if (block.type === "tool_use" && includeToolNames) {
                        const tool = block as ToolUseBlock;
                        const fp = extractFilePathFromInput(tool.input);
                        parts.push(fp ? `[${tool.name}] ${fp}` : `[${tool.name}]`);
                    } else if (block.type === "image") {
                        parts.push(`[Image: ${(block as ImageBlock).source.media_type}]`);
                    } else if (block.type === "tool_reference") {
                        parts.push(`[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
                    }
                }
            } else if (msg.type === "summary") {
                parts.push((msg as SummaryMessage).summary);
            } else if (msg.type === "custom-title") {
                parts.push((msg as CustomTitleMessage).customTitle);
            } else if (msg.type === "pr-link") {
                parts.push(`[PR Link]: ${(msg as PrLinkMessage).url}`);
            } else if (msg.type === "system" && includeSystemMessages) {
                const sysMsg = msg as SystemMessage;
                parts.push(`[System: ${sysMsg.subtype}]`);
            } else if (msg.type === "subagent") {
                const sub = msg as SubagentMessage;
                if (sub.role === "user") {
                    const text = extractUserText((sub.message as UserMessageContent).content);
                    if (text) parts.push(text);
                } else if (sub.role === "assistant") {
                    const content = (sub.message as AssistantMessageContent).content;
                    for (const block of content) {
                        if (block.type === "text") {
                            parts.push((block as TextBlock).text);
                        } else if (block.type === "image") {
                            parts.push(`[Image: ${(block as ImageBlock).source.media_type}]`);
                        } else if (block.type === "tool_reference") {
                            parts.push(`[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
                        }
                    }
                }
            }

            // Handle tool results inside user messages
            if (includeToolResults && msg.type === "user") {
                const userMsg = msg as UserMessage;
                if (Array.isArray(userMsg.message.content)) {
                    for (const block of userMsg.message.content) {
                        if (block.type === "tool_result") {
                            const tr = block as ToolResultBlock;
                            if (typeof tr.content === "string") {
                                parts.push(`[Tool Result]: ${tr.content}`);
                            }
                        }
                    }
                }
            }
        }

        let result = parts.join("\n");
        if (maxLength && result.length > maxLength) {
            result = result.slice(0, maxLength);
        }
        return result;
    }

    /**
     * Extract all tool calls from assistant and subagent assistant messages with metadata.
     * @returns Array of `ToolCallSummary` in chronological order.
     */
    extractToolCalls(): ToolCallSummary[] {
        const calls: ToolCallSummary[] = [];

        for (const msg of this._messages) {
            const timestamp = hasTimestamp(msg) ? msg.timestamp : undefined;

            if (msg.type === "assistant") {
                for (const block of getToolUseBlocks(msg as AssistantMessage)) {
                    calls.push({
                        name: block.name,
                        input: block.input,
                        filePath: extractFilePathFromInput(block.input),
                        timestamp,
                    });
                }
            } else if (msg.type === "subagent") {
                for (const block of getSubagentToolUseBlocks(msg as SubagentMessage)) {
                    calls.push({
                        name: block.name,
                        input: block.input,
                        filePath: extractFilePathFromInput(block.input),
                        timestamp,
                    });
                }
            }
        }

        return calls;
    }

    /**
     * Extract unique file paths referenced in tool calls (assistant + subagent).
     * Checks common input fields: `file_path`, `path`, `filePath`, `notebook_path`.
     */
    extractFilePaths(): string[] {
        if (this._filePathsCache) return this._filePathsCache;

        const paths = new Set<string>();

        for (const msg of this._messages) {
            let toolBlocks: ToolUseBlock[] = [];
            if (msg.type === "assistant") {
                toolBlocks = getToolUseBlocks(msg as AssistantMessage);
            } else if (msg.type === "subagent") {
                toolBlocks = getSubagentToolUseBlocks(msg as SubagentMessage);
            }
            for (const tool of toolBlocks) {
                const fp = extractFilePathFromInput(tool.input);
                if (fp) paths.add(fp);
            }
        }

        this._filePathsCache = [...paths];
        return this._filePathsCache;
    }

    /**
     * Extract git commit hashes found in tool results.
     * Looks for 7-40 character hex strings near git commit keywords.
     */
    extractCommitHashes(): string[] {
        const hashes = new Set<string>();
        const commitPattern = /\b([a-f0-9]{7,40})\b/gi;
        const gitCommitContext = /git commit|committed|Commit:|create mode|\[master|^\[main/i;

        for (const msg of this._messages) {
            // Check tool results in user messages (these contain git output)
            if (msg.type === "user") {
                const userMsg = msg as UserMessage;
                if (Array.isArray(userMsg.message.content)) {
                    for (const block of userMsg.message.content) {
                        if (block.type === "tool_result" && typeof block.content === "string") {
                            if (gitCommitContext.test(block.content)) {
                                const matches = block.content.match(commitPattern);
                                if (matches) {
                                    for (const match of matches) {
                                        if (match.length >= 7 && !/^(.)\1+$/.test(match)) {
                                            hashes.add(match);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Check bash progress messages (real-time command output)
            if (msg.type === "progress") {
                const progressMsg = msg as ProgressMessage;
                if (progressMsg.data.type === "bash_progress") {
                    const output = progressMsg.data.output || "";
                    if (gitCommitContext.test(output)) {
                        const matches = output.match(commitPattern);
                        if (matches) {
                            for (const match of matches) {
                                if (match.length >= 7 && !/^(.)\1+$/.test(match)) {
                                    hashes.add(match);
                                }
                            }
                        }
                    }
                }
            }
        }

        return [...hashes];
    }

    /**
     * Extract all thinking/reasoning blocks from assistant and subagent messages.
     * @returns Array of thinking text strings in chronological order.
     */
    extractThinkingBlocks(): string[] {
        const blocks: string[] = [];

        for (const msg of this._messages) {
            let contentBlocks: ContentBlock[] | undefined;
            if (msg.type === "assistant") {
                contentBlocks = (msg as AssistantMessage).message.content;
            } else if (msg.type === "subagent" && (msg as SubagentMessage).role === "assistant") {
                contentBlocks = ((msg as SubagentMessage).message as AssistantMessageContent).content;
            }
            if (!contentBlocks) continue;
            for (const block of contentBlocks) {
                if (block.type === "thinking") {
                    blocks.push((block as ThinkingBlock).thinking);
                }
            }
        }

        return blocks;
    }

    /**
     * Extract all PR link URLs from pr-link messages.
     * @returns Array of URL strings in chronological order.
     */
    extractPrLinks(): string[] {
        return this._messages
            .filter((m): m is PrLinkMessage => m.type === "pr-link")
            .map((m) => m.url);
    }

    // =========================================================================
    // Filtering (returns new ClaudeSession with filtered messages)
    // =========================================================================

    /**
     * Return a new session containing only messages that reference the given tool.
     * Matches assistant and subagent messages with a tool_use block of that name,
     * plus adjacent user messages containing the tool_result.
     */
    filterByTool(toolName: string): ClaudeSession {
        const lowerName = toolName.toLowerCase();
        const matchingToolUseIds = new Set<string>();
        const filtered: ConversationMessage[] = [];

        // First pass: find matching assistant/subagent messages and collect tool_use IDs
        for (const msg of this._messages) {
            let tools: ToolUseBlock[] = [];
            if (msg.type === "assistant") {
                tools = getToolUseBlocks(msg as AssistantMessage);
            } else if (msg.type === "subagent") {
                tools = getSubagentToolUseBlocks(msg as SubagentMessage);
            }
            if (tools.length === 0) continue;

            const hasMatch = tools.some((t) => t.name.toLowerCase() === lowerName);
            if (hasMatch) {
                filtered.push(msg);
                for (const t of tools) {
                    if (t.name.toLowerCase() === lowerName) {
                        matchingToolUseIds.add(t.id);
                    }
                }
            }
        }

        // Second pass: find user messages with matching tool_results
        for (const msg of this._messages) {
            if (msg.type === "user") {
                const userMsg = msg as UserMessage;
                if (Array.isArray(userMsg.message.content)) {
                    const hasResult = userMsg.message.content.some(
                        (b) => b.type === "tool_result" && matchingToolUseIds.has((b as ToolResultBlock).tool_use_id),
                    );
                    if (hasResult) {
                        filtered.push(msg);
                    }
                }
            }
        }

        // Maintain chronological order using the original message index
        const indexMap = new Map(this._messages.map((m, i) => [m, i]));
        filtered.sort((a, b) => (indexMap.get(a) ?? 0) - (indexMap.get(b) ?? 0));

        return new ClaudeSession(this._filePath, filtered);
    }

    /**
     * Return a new session with only messages within the given date range.
     * Messages without timestamps are excluded.
     */
    filterByDateRange(since?: Date, until?: Date): ClaudeSession {
        if (!since && !until) return this;

        const filtered = this._messages.filter((msg) => {
            if (!hasTimestamp(msg)) return false;
            const ts = new Date(msg.timestamp);
            if (since && ts < since) return false;
            if (until && ts > until) return false;
            return true;
        });

        return new ClaudeSession(this._filePath, filtered);
    }

    /**
     * Return a new session with only messages whose text content matches the query.
     * Case-insensitive substring match. Searches across user, assistant, subagent,
     * summary, custom-title, and pr-link messages.
     */
    filterByContent(query: string): ClaudeSession {
        const lowerQuery = query.toLowerCase();

        const filtered = this._messages.filter((msg) => {
            let text = "";
            if (msg.type === "user") {
                text = extractUserText((msg as UserMessage).message.content);
            } else if (msg.type === "assistant") {
                const blocks = (msg as AssistantMessage).message.content;
                text = blocks
                    .filter((b): b is TextBlock => b.type === "text")
                    .map((b) => b.text)
                    .join(" ");
            } else if (msg.type === "subagent") {
                const sub = msg as SubagentMessage;
                if (sub.role === "user") {
                    text = extractUserText((sub.message as UserMessageContent).content);
                } else {
                    const blocks = (sub.message as AssistantMessageContent).content;
                    text = blocks
                        .filter((b): b is TextBlock => b.type === "text")
                        .map((b) => b.text)
                        .join(" ");
                }
            } else if (msg.type === "summary") {
                text = (msg as SummaryMessage).summary;
            } else if (msg.type === "custom-title") {
                text = (msg as CustomTitleMessage).customTitle;
            } else if (msg.type === "pr-link") {
                text = (msg as PrLinkMessage).url;
            }
            return text.toLowerCase().includes(lowerQuery);
        });

        return new ClaudeSession(this._filePath, filtered);
    }

    /**
     * Return a new session containing only messages of the specified types.
     */
    filterByMessageType(...types: MessageType[]): ClaudeSession {
        const typeSet = new Set(types);
        const filtered = this._messages.filter((msg) => typeSet.has(msg.type));
        return new ClaudeSession(this._filePath, filtered);
    }

    // =========================================================================
    // Statistics
    // =========================================================================

    /** Aggregated statistics for this session (computed once, then cached). */
    get stats(): SessionStats {
        if (this._stats) return this._stats;

        let userMessageCount = 0;
        let assistantMessageCount = 0;
        let systemMessageCount = 0;
        let subagentMessageCount = 0;
        let progressMessageCount = 0;
        let prLinkCount = 0;
        let toolCallCount = 0;
        const toolUsage: Record<string, number> = {};
        const tokenUsage = { input: 0, output: 0, cached: 0 };
        const modelsSet = new Set<string>();
        const filesSet = new Set<string>();
        let firstTimestamp: Date | null = null;
        let lastTimestamp: Date | null = null;

        for (const msg of this._messages) {
            // Track timestamps
            if (hasTimestamp(msg)) {
                const ts = new Date(msg.timestamp);
                if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
                if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
            }

            if (msg.type === "user") {
                userMessageCount++;
            } else if (msg.type === "assistant") {
                assistantMessageCount++;
                const assistantMsg = msg as AssistantMessage;

                // Model
                if (assistantMsg.message.model) {
                    modelsSet.add(assistantMsg.message.model);
                }

                // Token usage
                const usage: Usage | undefined = assistantMsg.message.usage;
                if (usage) {
                    tokenUsage.input += usage.input_tokens || 0;
                    tokenUsage.output += usage.output_tokens || 0;
                    tokenUsage.cached += usage.cache_read_input_tokens || 0;
                }

                // Tool calls
                for (const tool of getToolUseBlocks(assistantMsg)) {
                    toolCallCount++;
                    toolUsage[tool.name] = (toolUsage[tool.name] || 0) + 1;
                    const fp = extractFilePathFromInput(tool.input);
                    if (fp) filesSet.add(fp);
                }
            } else if (msg.type === "system") {
                systemMessageCount++;
            } else if (msg.type === "subagent") {
                subagentMessageCount++;
                const sub = msg as SubagentMessage;

                // Track subagent assistant models and token usage
                if (sub.role === "assistant") {
                    const assistantContent = sub.message as AssistantMessageContent;
                    if (assistantContent.model) modelsSet.add(assistantContent.model);
                    if (assistantContent.usage) {
                        tokenUsage.input += assistantContent.usage.input_tokens || 0;
                        tokenUsage.output += assistantContent.usage.output_tokens || 0;
                        tokenUsage.cached += assistantContent.usage.cache_read_input_tokens || 0;
                    }
                    // Track subagent tool calls
                    for (const tool of getSubagentToolUseBlocks(sub)) {
                        toolCallCount++;
                        toolUsage[tool.name] = (toolUsage[tool.name] || 0) + 1;
                        const fp = extractFilePathFromInput(tool.input);
                        if (fp) filesSet.add(fp);
                    }
                }
            } else if (msg.type === "progress") {
                progressMessageCount++;
            } else if (msg.type === "pr-link") {
                prLinkCount++;
            }
        }

        const duration =
            firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

        this._stats = {
            messageCount: this._messages.length,
            userMessageCount,
            assistantMessageCount,
            systemMessageCount,
            subagentMessageCount,
            progressMessageCount,
            prLinkCount,
            toolCallCount,
            toolUsage,
            tokenUsage,
            modelsUsed: [...modelsSet],
            filesModified: [...filesSet],
            duration,
            firstTimestamp,
            lastTimestamp,
        };

        return this._stats;
    }

    // =========================================================================
    // LLM Preparation
    // =========================================================================

    /**
     * Prepare a token-budgeted, readable transcript of the session for LLM consumption.
     *
     * Formatting:
     * - `[User]: <text>` for user messages
     * - `[Assistant]: <text>` for assistant text blocks
     * - `[Tool: <Name>] <file>` for tool invocations
     * - `[Tool Result]: <text>` only if `includeToolResults` is true
     * - `[Thinking]: <text>` only if `includeThinking` is true
     *
     * Priority modes:
     * - `balanced` — chronological order, stops when budget is reached
     * - `user-first` — all user messages first, then assistant, then tools
     * - `assistant-first` — all assistant text first, then user, then tools
     *
     * The first and last messages are always included (session bookends).
     */
    toPromptContent(options: PromptContentOptions): PreparedContent {
        const {
            tokenBudget,
            priority,
            includeToolResults = false,
            includeThinking = false,
            includeTimestamps = false,
        } = options;

        // Format a single message into readable lines
        const formatMessage = (msg: ConversationMessage): string[] => {
            // Skip progress messages — they are noisy real-time updates
            if (msg.type === "progress") return [];

            const lines: string[] = [];
            const timestamp = includeTimestamps && hasTimestamp(msg) ? `[${msg.timestamp}] ` : "";

            if (msg.type === "user") {
                const userMsg = msg as UserMessage;
                const text = typeof userMsg.message.content === "string"
                    ? userMsg.message.content
                    : this._extractUserTextBlocks(userMsg.message.content, includeToolResults);
                if (text.trim()) {
                    lines.push(`${timestamp}[User]: ${text.trim()}`);
                }
            } else if (msg.type === "assistant") {
                const assistantMsg = msg as AssistantMessage;
                for (const block of assistantMsg.message.content) {
                    if (block.type === "text") {
                        const text = (block as TextBlock).text.trim();
                        if (text) lines.push(`${timestamp}[Assistant]: ${text}`);
                    } else if (block.type === "thinking" && includeThinking) {
                        const text = (block as ThinkingBlock).thinking.trim();
                        if (text) lines.push(`${timestamp}[Thinking]: ${text}`);
                    } else if (block.type === "tool_use") {
                        const tool = block as ToolUseBlock;
                        const fp = extractFilePathFromInput(tool.input);
                        lines.push(`${timestamp}[Tool: ${tool.name}]${fp ? ` ${fp}` : ""}`);
                    } else if (block.type === "image") {
                        lines.push(`${timestamp}[Image: ${(block as ImageBlock).source.media_type}]`);
                    } else if (block.type === "tool_reference") {
                        lines.push(`${timestamp}[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
                    }
                }
            } else if (msg.type === "subagent") {
                const sub = msg as SubagentMessage;
                if (sub.role === "user") {
                    const content = (sub.message as UserMessageContent).content;
                    const text = typeof content === "string"
                        ? content
                        : this._extractUserTextBlocks(content, includeToolResults);
                    if (text.trim()) {
                        lines.push(`${timestamp}[Subagent User]: ${text.trim()}`);
                    }
                } else {
                    const content = (sub.message as AssistantMessageContent).content;
                    for (const block of content) {
                        if (block.type === "text") {
                            const text = (block as TextBlock).text.trim();
                            if (text) lines.push(`${timestamp}[Subagent]: ${text}`);
                        } else if (block.type === "thinking" && includeThinking) {
                            const text = (block as ThinkingBlock).thinking.trim();
                            if (text) lines.push(`${timestamp}[Subagent Thinking]: ${text}`);
                        } else if (block.type === "tool_use") {
                            const tool = block as ToolUseBlock;
                            const fp = extractFilePathFromInput(tool.input);
                            lines.push(`${timestamp}[Subagent Tool: ${tool.name}]${fp ? ` ${fp}` : ""}`);
                        } else if (block.type === "image") {
                            lines.push(`${timestamp}[Image: ${(block as ImageBlock).source.media_type}]`);
                        } else if (block.type === "tool_reference") {
                            lines.push(`${timestamp}[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
                        }
                    }
                }
            } else if (msg.type === "summary") {
                lines.push(`${timestamp}[Summary]: ${(msg as SummaryMessage).summary}`);
            } else if (msg.type === "pr-link") {
                lines.push(`${timestamp}[PR Link]: ${(msg as PrLinkMessage).url}`);
            }

            return lines;
        };

        // Determine message order based on priority
        let orderedMessages: ConversationMessage[];

        if (priority === "balanced") {
            orderedMessages = [...this._messages];
        } else if (priority === "user-first") {
            const user = this._messages.filter((m) => m.type === "user");
            const assistant = this._messages.filter((m) => m.type === "assistant");
            const other = this._messages.filter((m) => m.type !== "user" && m.type !== "assistant");
            orderedMessages = [...user, ...assistant, ...other];
        } else {
            // assistant-first
            const assistant = this._messages.filter((m) => m.type === "assistant");
            const user = this._messages.filter((m) => m.type === "user");
            const other = this._messages.filter((m) => m.type !== "user" && m.type !== "assistant");
            orderedMessages = [...assistant, ...user, ...other];
        }

        // Format first and last messages (bookends) — always included
        const firstMsg = this._messages[0];
        const lastMsg = this._messages.length > 1 ? this._messages[this._messages.length - 1] : null;
        const firstLines = firstMsg ? formatMessage(firstMsg) : [];
        const lastLines = lastMsg && lastMsg !== firstMsg ? formatMessage(lastMsg) : [];
        const bookendText = [...firstLines, ...lastLines].join("\n");
        const bookendTokens = estimateTokens(bookendText);

        // If bookends alone exceed budget, return just what fits
        if (bookendTokens >= tokenBudget) {
            const content = bookendText.slice(0, tokenBudget * 4); // ~4 chars/token
            return {
                content,
                tokenCount: estimateTokens(content),
                truncated: true,
                truncationInfo: `Session has ${this._messages.length} messages; only bookend messages fit within ${tokenBudget} token budget.`,
                stats: this._buildPreparedStats(),
            };
        }

        // Build content within budget
        let remainingBudget = tokenBudget - bookendTokens;
        const contentParts: string[] = [...firstLines];
        let truncated = false;
        let includedCount = firstMsg ? 1 : 0;

        // Track which messages are bookends to avoid duplicates
        const bookendSet = new Set<ConversationMessage>();
        if (firstMsg) bookendSet.add(firstMsg);
        if (lastMsg) bookendSet.add(lastMsg);

        for (const msg of orderedMessages) {
            if (bookendSet.has(msg)) continue;

            const lines = formatMessage(msg);
            if (lines.length === 0) continue;

            const text = lines.join("\n");
            const tokens = estimateTokens(text);

            if (tokens > remainingBudget) {
                truncated = true;
                break;
            }

            contentParts.push(text);
            remainingBudget -= tokens;
            includedCount++;
        }

        // Append last message bookend
        if (lastLines.length > 0) {
            contentParts.push(...lastLines);
            includedCount++;
        }

        const content = contentParts.join("\n\n");
        const totalMessages = this._messages.length;
        const truncationInfo = truncated
            ? `Included ${includedCount} of ${totalMessages} messages (${priority} priority). Budget: ${tokenBudget} tokens.`
            : `All ${totalMessages} messages included within ${tokenBudget} token budget.`;

        return {
            content,
            tokenCount: estimateTokens(content),
            truncated,
            truncationInfo,
            stats: this._buildPreparedStats(),
        };
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /**
     * Extract text from user content blocks, optionally including tool results.
     */
    private _extractUserTextBlocks(content: ContentBlock[], includeToolResults: boolean): string {
        const parts: string[] = [];
        for (const block of content) {
            if (block.type === "text") {
                parts.push((block as TextBlock).text);
            } else if (block.type === "image") {
                parts.push(`[Image: ${(block as ImageBlock).source.media_type}]`);
            } else if (block.type === "tool_reference") {
                parts.push(`[Tool Reference: ${(block as ToolReferenceBlock).tool_name}]`);
            } else if (block.type === "tool_result" && includeToolResults) {
                const tr = block as ToolResultBlock;
                if (typeof tr.content === "string") {
                    parts.push(`[Tool Result]: ${tr.content}`);
                } else if (Array.isArray(tr.content)) {
                    for (const inner of tr.content) {
                        if (inner.type === "text") parts.push((inner as TextBlock).text);
                        else if (inner.type === "image") parts.push(`[Image: ${(inner as ImageBlock).source.media_type}]`);
                        else if (inner.type === "tool_reference") parts.push(`[Tool Reference: ${(inner as ToolReferenceBlock).tool_name}]`);
                    }
                }
            }
        }
        return parts.join("\n");
    }

    /**
     * Build the stats sub-object for PreparedContent.
     */
    private _buildPreparedStats(): PreparedContent["stats"] {
        const s = this.stats;
        return {
            userMessages: s.userMessageCount,
            assistantMessages: s.assistantMessageCount,
            toolCalls: s.toolCallCount,
            filesModified: s.filesModified,
        };
    }
}
