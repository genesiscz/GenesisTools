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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { estimateTokens } from "@app/utils/tokens";
import { discoverSessionFiles } from "./discovery";
import { parseJsonlTranscript } from "./index";
import { encodedProjectDir, extractProjectName, PROJECTS_DIR } from "./projects";
import {
    agentProgressToSubagent,
    extractFilePathFromInput,
    extractUserText,
    getSubagentToolUseBlocks,
    getToolUseBlocks,
    hasCwd,
    hasGitBranch,
    hasSessionId,
    hasTimestamp,
    isSubagentFile,
    readHeadTailLines,
} from "./session.utils";
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

// Re-export types and utils for backward compatibility
export type {
    AgentMeta,
    ExtractTextOptions,
    PreparedContent,
    PromptContentOptions,
    SessionDiscoveryOptions,
    SessionInfo,
    SessionStats,
    TailTarget,
    ToolCallSummary,
} from "./session.types";
export {
    extractFilePathFromInput,
    extractUserText,
    getSubagentToolUseBlocks,
    getToolUseBlocks,
    hasCwd,
    hasGitBranch,
    hasSessionId,
    hasTimestamp,
    isSubagentFile,
    readHeadTailLines,
} from "./session.utils";

import type {
    AgentMeta,
    ExtractTextOptions,
    PreparedContent,
    PromptContentOptions,
    SessionDiscoveryOptions,
    SessionInfo,
    SessionStats,
    TailTarget,
    ToolCallSummary,
} from "./session.types";

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
        const raw = await parseJsonlTranscript<ConversationMessage>(filePath);
        const messages = raw.map((msg) => {
            if (msg.type === "progress") {
                return agentProgressToSubagent(msg as ProgressMessage) ?? msg;
            }

            return msg;
        });
        return new ClaudeSession(filePath, messages);
    }

    /**
     * Load a session by its session ID (full UUID or 8-char prefix).
     * Scans the project directory for a matching filename.
     * When no explicit projectDir is given, falls back to scanning all projects.
     *
     * @param sessionId Full UUID or prefix (minimum 8 characters).
     * @param projectDir Encoded project directory name. Defaults to the current cwd encoding.
     * @throws {Error} If no matching session file is found.
     */
    static async fromSessionId(sessionId: string, projectDir?: string): Promise<ClaudeSession> {
        const dir = projectDir ? resolve(PROJECTS_DIR, projectDir) : resolve(PROJECTS_DIR, encodedProjectDir());

        if (existsSync(dir)) {
            const found = ClaudeSession.findSessionFileInDir(dir, sessionId);
            if (found) {
                return ClaudeSession.fromFile(found);
            }
        }

        // Fallback: scan all project directories (only when no explicit projectDir was given)
        if (!projectDir) {
            let projectDirs: string[];
            try {
                projectDirs = readdirSync(PROJECTS_DIR);
            } catch {
                projectDirs = [];
            }

            const currentEncoded = existsSync(dir) ? basename(dir) : null;
            for (const entry of projectDirs) {
                if (entry === currentEncoded) {
                    continue;
                }

                const candidateDir = resolve(PROJECTS_DIR, entry);
                const found = ClaudeSession.findSessionFileInDir(candidateDir, sessionId);
                if (found) {
                    return ClaudeSession.fromFile(found);
                }
            }
        }

        throw new Error(`No session file found for ID prefix "${sessionId}" in ${dir} (also searched all projects)`);
    }

    /**
     * Search a single project directory (and its subagents/) for a session file
     * matching the given ID (exact or prefix).
     */
    private static findSessionFileInDir(dir: string, sessionId: string): string | null {
        const exactPath = resolve(dir, `${sessionId}.jsonl`);
        if (existsSync(exactPath)) {
            return exactPath;
        }

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
                    return resolve(searchDir, entry);
                }
            }
        }

        return null;
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
        const { project, allProjects = false, since, until, includeSubagents = false, limit } = options;

        // Discover files using shared discovery layer
        const projectFilter = project ? encodedProjectDir(project) : undefined;
        const files = await discoverSessionFiles({
            project: projectFilter,
            allProjects,
            includeSubagents,
            excludeSubagents: !includeSubagents,
        });

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
                let lastTimestamp: Date | null = null;
                let messageCount = 0;

                for (const line of lines) {
                    try {
                        const obj = SafeJSON.parse(line) as Record<string, unknown>;
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
                        if (typeof obj.timestamp === "string") {
                            const ts = new Date(obj.timestamp);

                            if (!startDate) {
                                startDate = ts;
                            }

                            if (!lastTimestamp || ts > lastTimestamp) {
                                lastTimestamp = ts;
                            }
                        }
                    } catch {
                        // Skip unparseable lines
                    }
                }

                // Derive project name from encoded path via filesystem-walking resolver
                projectName = extractProjectName(filePath) || null;

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
                if (since && startDate && startDate < since) {
                    continue;
                }
                if (until && startDate && startDate > until) {
                    continue;
                }

                results.push({
                    filePath,
                    sessionId: sessionId || basename(filePath, ".jsonl"),
                    title,
                    summary,
                    gitBranch,
                    project: projectName,
                    startDate,
                    lastTimestamp,
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

    /**
     * Discover subagent files matching a query (ID prefix or description substring).
     *
     * Scans `<session-id>/subagents/` directories for `agent-*.meta.json` files.
     *
     * @returns Array of `TailTarget` sorted by file mtime (newest first).
     */
    static findSubagents(
        options: { query?: string; project?: string; sessionId?: string; allProjects?: boolean } = {}
    ): TailTarget[] {
        const { query, project, sessionId, allProjects = false } = options;

        const baseDirs: string[] = [];

        if (allProjects) {
            if (existsSync(PROJECTS_DIR)) {
                try {
                    for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
                        if (entry.isDirectory()) {
                            baseDirs.push(resolve(PROJECTS_DIR, entry.name));
                        }
                    }
                } catch {
                    // Skip unreadable
                }
            }
        } else {
            const dir = project
                ? resolve(PROJECTS_DIR, encodedProjectDir(project))
                : resolve(PROJECTS_DIR, encodedProjectDir());

            if (existsSync(dir)) {
                baseDirs.push(dir);
            }
        }

        if (baseDirs.length === 0) {
            return [];
        }

        const results: TailTarget[] = [];
        const lowerQuery = query?.toLowerCase();

        // Collect subagent dirs from all base dirs
        const sessionDirs: string[] = [];

        for (const baseDir of baseDirs) {
            if (sessionId) {
                try {
                    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
                        if (entry.isDirectory() && entry.name.toLowerCase().startsWith(sessionId.toLowerCase())) {
                            const subagentsDir = resolve(baseDir, entry.name, "subagents");

                            if (existsSync(subagentsDir)) {
                                sessionDirs.push(subagentsDir);
                            }
                        }
                    }
                } catch {
                    // Skip unreadable directories
                }
            } else {
                try {
                    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
                        if (entry.isDirectory()) {
                            const subagentsDir = resolve(baseDir, entry.name, "subagents");

                            if (existsSync(subagentsDir)) {
                                sessionDirs.push(subagentsDir);
                            }
                        }
                    }
                } catch {
                    // Skip unreadable directories
                }
            }
        }

        for (const subagentsDir of sessionDirs) {
            let entries: string[];

            try {
                entries = readdirSync(subagentsDir);
            } catch {
                continue;
            }

            // Find all meta.json files
            const metaFiles = entries.filter((e) => e.endsWith(".meta.json"));

            for (const metaFile of metaFiles) {
                const agentId = metaFile.replace(".meta.json", "").replace("agent-", "");
                const jsonlFile = metaFile.replace(".meta.json", ".jsonl");
                const jsonlPath = resolve(subagentsDir, jsonlFile);

                if (!existsSync(jsonlPath)) {
                    continue;
                }

                let meta: AgentMeta | null = null;

                try {
                    const metaText = readFileSync(resolve(subagentsDir, metaFile), "utf-8");
                    meta = SafeJSON.parse(metaText, { strict: true }) as AgentMeta;
                } catch {
                    // Skip unreadable meta files
                }

                // Derive session ID from parent directory name
                const parentDir = basename(dirname(subagentsDir));

                // Match against query
                if (lowerQuery) {
                    const idMatch = agentId.toLowerCase().startsWith(lowerQuery);
                    const descMatch = meta?.description?.toLowerCase().includes(lowerQuery) ?? false;

                    if (!idMatch && !descMatch) {
                        continue;
                    }
                }

                results.push({
                    filePath: jsonlPath,
                    label: meta?.description ?? `agent-${agentId}`,
                    sessionId: parentDir,
                    agentId,
                    agentDescription: meta?.description,
                    isAgent: true,
                });
            }
        }

        // Pre-compute mtimes to avoid repeated statSync calls in comparator
        const mtimeMap = new Map<string, number>();

        for (const target of results) {
            try {
                mtimeMap.set(target.filePath, statSync(target.filePath).mtimeMs);
            } catch {
                mtimeMap.set(target.filePath, 0);
            }
        }

        results.sort((a, b) => (mtimeMap.get(b.filePath) ?? 0) - (mtimeMap.get(a.filePath) ?? 0));

        return results;
    }

    // =========================================================================
    // Metadata Accessors
    // =========================================================================

    /** The session ID extracted from the first message that carries one, or null. */
    get sessionId(): string | null {
        for (const msg of this._messages) {
            if (hasSessionId(msg)) {
                return msg.sessionId;
            }
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
            if (hasGitBranch(msg)) {
                return msg.gitBranch;
            }
        }
        return null;
    }

    /** The working directory (cwd) recorded in the session, or null. */
    get cwd(): string | null {
        for (const msg of this._messages) {
            if (hasCwd(msg)) {
                return msg.cwd;
            }
        }
        return null;
    }

    /** The project name derived from the file path (last path segment of the decoded cwd). */
    get project(): string | null {
        const pathAfterProjects = this._filePath.replace(PROJECTS_DIR + sep, "");
        const encodedDir = pathAfterProjects.split(sep)[0];
        if (!encodedDir) {
            return null;
        }
        const parts = encodedDir.split("-").filter(Boolean);
        return parts[parts.length - 1] || null;
    }

    /** Timestamp of the first message in the session. */
    get startDate(): Date | null {
        for (const msg of this._messages) {
            if (hasTimestamp(msg)) {
                return new Date(msg.timestamp);
            }
        }
        return null;
    }

    /** Timestamp of the last message in the session. */
    get endDate(): Date | null {
        for (let i = this._messages.length - 1; i >= 0; i--) {
            const msg = this._messages[i];
            if (hasTimestamp(msg)) {
                return new Date(msg.timestamp);
            }
        }
        return null;
    }

    /** Duration in milliseconds between first and last message. */
    get duration(): number {
        const start = this.startDate;
        const end = this.endDate;
        if (!start || !end) {
            return 0;
        }
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
            if (msg.type === "progress") {
                continue;
            }

            if (msg.type === "user") {
                const userMsg = msg as UserMessage;
                const text = extractUserText(userMsg.message.content);
                if (text) {
                    parts.push(text);
                }
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
                    if (text) {
                        parts.push(text);
                    }
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
                for (const block of getToolUseBlocks((msg as AssistantMessage).message.content)) {
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
        if (this._filePathsCache) {
            return this._filePathsCache;
        }

        const paths = new Set<string>();

        for (const msg of this._messages) {
            let toolBlocks: ToolUseBlock[] = [];
            if (msg.type === "assistant") {
                toolBlocks = getToolUseBlocks((msg as AssistantMessage).message.content);
            } else if (msg.type === "subagent") {
                toolBlocks = getSubagentToolUseBlocks(msg as SubagentMessage);
            }
            for (const tool of toolBlocks) {
                const fp = extractFilePathFromInput(tool.input);
                if (fp) {
                    paths.add(fp);
                }
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
            if (!contentBlocks) {
                continue;
            }
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
        return this._messages.filter((m): m is PrLinkMessage => m.type === "pr-link").map((m) => m.url);
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
                tools = getToolUseBlocks((msg as AssistantMessage).message.content);
            } else if (msg.type === "subagent") {
                tools = getSubagentToolUseBlocks(msg as SubagentMessage);
            }
            if (tools.length === 0) {
                continue;
            }

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
                        (b) => b.type === "tool_result" && matchingToolUseIds.has((b as ToolResultBlock).tool_use_id)
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
        if (!since && !until) {
            return this;
        }

        const filtered = this._messages.filter((msg) => {
            if (!hasTimestamp(msg)) {
                return false;
            }
            const ts = new Date(msg.timestamp);
            if (since && ts < since) {
                return false;
            }
            if (until && ts > until) {
                return false;
            }
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
            return (text ?? "").toLowerCase().includes(lowerQuery);
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
        if (this._stats) {
            return this._stats;
        }

        let userMessageCount = 0;
        let assistantMessageCount = 0;
        let systemMessageCount = 0;
        let subagentMessageCount = 0;
        let progressMessageCount = 0;
        let prLinkCount = 0;
        let toolCallCount = 0;
        const toolUsage: Record<string, number> = {};
        const tokenUsage = { input: 0, output: 0, cached: 0 };
        const serverToolUse = { webSearchRequests: 0, webFetchRequests: 0 };
        const modelsSet = new Set<string>();
        const filesSet = new Set<string>();
        let firstTimestamp: Date | null = null;
        let lastTimestamp: Date | null = null;

        for (const msg of this._messages) {
            // Track timestamps
            if (hasTimestamp(msg)) {
                const ts = new Date(msg.timestamp);
                if (!firstTimestamp || ts < firstTimestamp) {
                    firstTimestamp = ts;
                }
                if (!lastTimestamp || ts > lastTimestamp) {
                    lastTimestamp = ts;
                }
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

                    if (usage.server_tool_use) {
                        serverToolUse.webSearchRequests += usage.server_tool_use.web_search_requests || 0;
                        serverToolUse.webFetchRequests += usage.server_tool_use.web_fetch_requests || 0;
                    }
                }

                // Tool calls
                for (const tool of getToolUseBlocks(assistantMsg.message.content)) {
                    toolCallCount++;
                    toolUsage[tool.name] = (toolUsage[tool.name] || 0) + 1;
                    const fp = extractFilePathFromInput(tool.input);
                    if (fp) {
                        filesSet.add(fp);
                    }
                }
            } else if (msg.type === "system") {
                systemMessageCount++;
            } else if (msg.type === "subagent") {
                subagentMessageCount++;
                const sub = msg as SubagentMessage;

                // Track subagent assistant models and token usage
                if (sub.role === "assistant") {
                    const assistantContent = sub.message as AssistantMessageContent;
                    if (assistantContent.model) {
                        modelsSet.add(assistantContent.model);
                    }
                    if (assistantContent.usage) {
                        tokenUsage.input += assistantContent.usage.input_tokens || 0;
                        tokenUsage.output += assistantContent.usage.output_tokens || 0;
                        tokenUsage.cached += assistantContent.usage.cache_read_input_tokens || 0;

                        if (assistantContent.usage.server_tool_use) {
                            serverToolUse.webSearchRequests +=
                                assistantContent.usage.server_tool_use.web_search_requests || 0;
                            serverToolUse.webFetchRequests +=
                                assistantContent.usage.server_tool_use.web_fetch_requests || 0;
                        }
                    }

                    // Track subagent tool calls
                    for (const tool of getSubagentToolUseBlocks(sub)) {
                        toolCallCount++;
                        toolUsage[tool.name] = (toolUsage[tool.name] || 0) + 1;
                        const fp = extractFilePathFromInput(tool.input);
                        if (fp) {
                            filesSet.add(fp);
                        }
                    }
                }
            } else if (msg.type === "progress") {
                progressMessageCount++;
            } else if (msg.type === "pr-link") {
                prLinkCount++;
            }
        }

        const duration = firstTimestamp && lastTimestamp ? lastTimestamp.getTime() - firstTimestamp.getTime() : 0;

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
            serverToolUse,
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
     * - `balanced` — summary-aware: always includes compaction summaries + recent
     *   post-summary context (70% budget) + early context (30% budget)
     * - `summary-first` — aggressive: summaries first, then all post-last-summary,
     *   then fill remaining chronologically
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
            if (msg.type === "progress") {
                return [];
            }

            const lines: string[] = [];
            const timestamp = includeTimestamps && hasTimestamp(msg) ? `[${msg.timestamp}] ` : "";

            if (msg.type === "user") {
                const userMsg = msg as UserMessage;
                const text =
                    typeof userMsg.message.content === "string"
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
                        if (text) {
                            lines.push(`${timestamp}[Assistant]: ${text}`);
                        }
                    } else if (block.type === "thinking" && includeThinking) {
                        const text = (block as ThinkingBlock).thinking.trim();
                        if (text) {
                            lines.push(`${timestamp}[Thinking]: ${text}`);
                        }
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
                    const text =
                        typeof content === "string"
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
                            if (text) {
                                lines.push(`${timestamp}[Subagent]: ${text}`);
                            }
                        } else if (block.type === "thinking" && includeThinking) {
                            const text = (block as ThinkingBlock).thinking.trim();
                            if (text) {
                                lines.push(`${timestamp}[Subagent Thinking]: ${text}`);
                            }
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

        // Use summary-aware algorithm for balanced/summary-first priorities
        if (priority === "balanced" || priority === "summary-first") {
            return this._buildSummaryAwareContent(formatMessage, tokenBudget, priority);
        }

        // Legacy priority modes: user-first / assistant-first
        let orderedMessages: ConversationMessage[];

        if (priority === "user-first") {
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
        if (firstMsg) {
            bookendSet.add(firstMsg);
        }
        if (lastMsg) {
            bookendSet.add(lastMsg);
        }

        for (const msg of orderedMessages) {
            if (bookendSet.has(msg)) {
                continue;
            }

            const lines = formatMessage(msg);
            if (lines.length === 0) {
                continue;
            }

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

    /**
     * Summary-aware content selection for balanced/summary-first priorities.
     *
     * Tier 1 (always): Bookends + all compaction summaries
     * Tier 2 (high priority): Messages after the last summary (recent unsummarized context)
     * Tier 3 (fill): Early context and between-summary messages
     *
     * For "balanced": 70% remaining budget to tier 2, 30% to tier 3
     * For "summary-first": 85% to tier 2, 15% to tier 3
     */
    private _buildSummaryAwareContent(
        formatMessage: (msg: ConversationMessage) => string[],
        tokenBudget: number,
        priority: "balanced" | "summary-first"
    ): PreparedContent {
        const totalMessages = this._messages.length;

        // Identify summary message indices
        const summaryIndices: number[] = [];
        for (let i = 0; i < totalMessages; i++) {
            if (this._messages[i].type === "summary") {
                summaryIndices.push(i);
            }
        }

        const lastSummaryIdx = summaryIndices.length > 0 ? summaryIndices[summaryIndices.length - 1] : -1;

        // Tier 1: bookends (first + last) + all summaries — always included
        const tier1Indices = new Set<number>();
        if (totalMessages > 0) {
            tier1Indices.add(0);
        }
        if (totalMessages > 1) {
            tier1Indices.add(totalMessages - 1);
        }
        for (const idx of summaryIndices) {
            tier1Indices.add(idx);
        }

        // Format tier 1 and calculate token cost
        const tier1Formatted = new Map<number, string>();
        let tier1Tokens = 0;

        for (const idx of tier1Indices) {
            const lines = formatMessage(this._messages[idx]);
            if (lines.length > 0) {
                const text = lines.join("\n");
                tier1Formatted.set(idx, text);
                tier1Tokens += estimateTokens(text);
            }
        }

        // If tier 1 alone exceeds budget, return just what fits
        if (tier1Tokens >= tokenBudget) {
            const sortedEntries = [...tier1Formatted.entries()].sort((a, b) => a[0] - b[0]);
            const parts: string[] = [];
            let usedTokens = 0;

            for (const [, text] of sortedEntries) {
                const tokens = estimateTokens(text);
                if (usedTokens + tokens > tokenBudget) {
                    break;
                }

                parts.push(text);
                usedTokens += tokens;
            }

            const content = parts.join("\n\n");
            return {
                content,
                tokenCount: estimateTokens(content),
                truncated: true,
                truncationInfo: `Session has ${totalMessages} messages; only summaries + bookends fit within ${tokenBudget} token budget.`,
                stats: this._buildPreparedStats(),
            };
        }

        const remainingBudget = tokenBudget - tier1Tokens;

        // Tier 2: messages after the last summary (recent unsummarized context)
        // These are filled backwards from the end to prioritize the most recent
        const tier2Indices: number[] = [];
        if (lastSummaryIdx >= 0) {
            for (let i = totalMessages - 2; i > lastSummaryIdx; i--) {
                if (!tier1Indices.has(i)) {
                    tier2Indices.push(i);
                }
            }
        } else {
            // No summaries: treat last 70% of messages as "recent"
            const recentStart = Math.floor(totalMessages * 0.3);
            for (let i = totalMessages - 2; i >= recentStart; i--) {
                if (!tier1Indices.has(i)) {
                    tier2Indices.push(i);
                }
            }
        }

        // Tier 3: everything else (early + between-summary context), forward order
        const tier2Set = new Set(tier2Indices);
        const tier3Indices: number[] = [];
        for (let i = 1; i < totalMessages - 1; i++) {
            if (!tier1Indices.has(i) && !tier2Set.has(i)) {
                tier3Indices.push(i);
            }
        }

        // Budget split: balanced = 70/30, summary-first = 85/15
        const tier2Ratio = priority === "summary-first" ? 0.85 : 0.7;
        const tier2Budget = Math.floor(remainingBudget * tier2Ratio);
        let tier3Budget = remainingBudget - tier2Budget;

        // Fill tier 2 (recent context, backwards from end)
        const includedIndices = new Set<number>(tier1Indices);
        const formattedMap = new Map<number, string>(tier1Formatted);
        let tier2Used = 0;

        for (const idx of tier2Indices) {
            const lines = formatMessage(this._messages[idx]);
            if (lines.length === 0) {
                continue;
            }

            const text = lines.join("\n");
            const tokens = estimateTokens(text);

            if (tier2Used + tokens > tier2Budget) {
                continue; // Try smaller messages
            }

            formattedMap.set(idx, text);
            includedIndices.add(idx);
            tier2Used += tokens;
        }

        // Give unused tier 2 budget to tier 3
        tier3Budget += tier2Budget - tier2Used;

        // Fill tier 3 (early context, forward from start)
        let tier3Used = 0;

        for (const idx of tier3Indices) {
            const lines = formatMessage(this._messages[idx]);
            if (lines.length === 0) {
                continue;
            }

            const text = lines.join("\n");
            const tokens = estimateTokens(text);

            if (tier3Used + tokens > tier3Budget) {
                continue; // Try smaller messages
            }

            formattedMap.set(idx, text);
            includedIndices.add(idx);
            tier3Used += tokens;
        }

        // Reassemble in chronological order
        const sortedEntries = [...formattedMap.entries()].sort((a, b) => a[0] - b[0]);
        const contentParts = sortedEntries.map(([, text]) => text);
        const content = contentParts.join("\n\n");

        const includedCount = includedIndices.size;
        const truncated = includedCount < totalMessages;

        const summaryCount = summaryIndices.filter((i) => includedIndices.has(i)).length;
        const recentCount = tier2Indices.filter((i) => includedIndices.has(i)).length;
        const earlyCount = tier3Indices.filter((i) => includedIndices.has(i)).length;

        const truncationInfo = truncated
            ? `Included ${includedCount} of ${totalMessages} messages (${priority}: ${summaryCount} summaries + ${recentCount} recent + ${earlyCount} early). Budget: ${tokenBudget} tokens.`
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
                        if (inner.type === "text") {
                            parts.push((inner as TextBlock).text);
                        } else if (inner.type === "image") {
                            parts.push(`[Image: ${(inner as ImageBlock).source.media_type}]`);
                        } else if (inner.type === "tool_reference") {
                            parts.push(`[Tool Reference: ${(inner as ToolReferenceBlock).tool_name}]`);
                        }
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
