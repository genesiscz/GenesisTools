/**
 * Claude Code Conversation History Library
 * Reusable functions for searching and parsing conversation history
 */

import { createReadStream, existsSync, readdirSync } from "fs";
import { stat } from "fs/promises";
import { glob } from "glob";
import { homedir } from "os";
import { basename, resolve, sep } from "path";
import { createInterface } from "readline";
import {
    getCacheStats as _getCacheStats,
    invalidateToday as _invalidateToday,
    aggregateDailyStats,
    type DailyStats,
    type DateRange,
    getAllSessionMetadata,
    getCachedDates,
    getSessionMetadataByDir,
    getCachedTotals,
    getDailyStats,
    getDailyStatsInRange,
    getDatabase,
    getFileIndex,
    getSessionMetadata,
    invalidateDateRange,
    setCacheMeta,
    type SessionMetadataRecord,
    type TokenUsage,
    updateCachedTotals,
    upsertDailyStats,
    upsertFileIndex,
    upsertSessionMetadata,
} from "./cache";
import type {
    AssistantMessage,
    ConversationMessage,
    ConversationMetadata,
    CustomTitleMessage,
    SearchFilters,
    SearchResult,
    SummaryMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    UserMessage,
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

    if (filters.agentsOnly) {
        // Only subagent files - preserve project scope if specified
        if (filters.project && filters.project !== "all") {
            // Transform project pattern to agent-specific patterns
            patterns.length = 0;
            patterns.push(`${PROJECTS_DIR}/*${filters.project}*/subagents/*.jsonl`);
            patterns.push(`${PROJECTS_DIR}/*${filters.project}*/agent-*.jsonl`);
        } else {
            // Search all projects for agents
            patterns.length = 0;
            patterns.push(`${PROJECTS_DIR}/**/subagents/*.jsonl`);
            patterns.push(`${PROJECTS_DIR}/**/agent-*.jsonl`);
        }
    }
    // else: Include both main and subagent files (default) - patterns already set

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
        })
    );
    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return fileStats.map((f) => f.path);
}

export function extractProjectName(filePath: string): string {
    // Extract project name from path like:
    // /Users/Martin/.claude/projects/-Users-Martin-Tresors-Projects-GenesisTools/...
    const projectDir = filePath.replace(PROJECTS_DIR + sep, "").split(sep)[0];
    // Only treat as encoded path if it starts with dash (like "-Users-Martin-...")
    // This preserves legitimate dashed project names like "my-cool-project"
    if (projectDir.startsWith("-")) {
        // Convert -Users-Martin-Tresors-Projects-GenesisTools to GenesisTools
        const parts = projectDir.split("-");
        return parts[parts.length - 1] || projectDir;
    }
    return projectDir;
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

/**
 * Check if a regex pattern is safe from ReDoS attacks.
 * Rejects patterns with nested quantifiers and excessive length.
 */
function isSafeRegex(pattern: string): boolean {
    // Reject excessively long patterns
    if (pattern.length > 200) return false;
    // Reject patterns with nested quantifiers (e.g., (a+)+ or (a*)*b*)
    const nestedQuantifiers = /(\+|\*|\?|\{[\d,]+\})\s*\)?\s*(\+|\*|\?|\{[\d,]+\})/;
    if (nestedQuantifiers.test(pattern)) return false;
    return true;
}

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
 * Calculate relevance score for a search result
 * Higher score = better match
 */
export function calculateRelevanceScore(
    query: string,
    summary: string | undefined,
    customTitle: string | undefined,
    firstUserMessage: string | undefined,
    allText: string,
    timestamp: Date
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

function matchesFilters(message: ConversationMessage, filters: SearchFilters, allText: string): boolean {
    // Query match
    if (filters.query) {
        if (!matchesQuery(allText, filters.query, !!filters.exact, !!filters.regex)) {
            return false;
        }
    }

    // Tool filter
    if (filters.tool) {
        const toolUses = extractToolUses(message);
        const hasMatchingTool = toolUses.some((t) => t.name.toLowerCase().includes(filters.tool!.toLowerCase()));
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
                const regexPattern = filePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
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
// =============================================================================

/**
 * Fast summary-only search using SQLite session_metadata cache.
 * No JSONL parsing needed — searches custom_title, summary, first_prompt.
 */
function searchSessionMetadataCache(filters: SearchFilters): SearchResult[] {
    // First ensure cache is populated for the target scope
    const all = filters.project
        ? getAllSessionMetadata().filter(
              (s) => s.project?.toLowerCase().includes(filters.project!.toLowerCase())
          )
        : getAllSessionMetadata();

    const results: SearchResult[] = [];

    for (const s of all) {
        if (filters.excludeAgents && s.isSubagent) continue;
        if (filters.agentsOnly && !s.isSubagent) continue;

        if (filters.excludeCurrentSession && s.sessionId === filters.excludeCurrentSession) continue;

        const firstTimestamp = s.firstTimestamp ? new Date(s.firstTimestamp) : undefined;
        if (filters.conversationDate && firstTimestamp && firstTimestamp < filters.conversationDate) continue;
        if (filters.conversationDateUntil && firstTimestamp && firstTimestamp > filters.conversationDateUntil) continue;

        const titleText = s.customTitle || s.summary || "";
        if (filters.query && !matchesQuery(titleText, filters.query, !!filters.exact, !!filters.regex)) {
            // Also check firstPrompt
            if (!s.firstPrompt || !matchesQuery(s.firstPrompt, filters.query, !!filters.exact, !!filters.regex)) {
                continue;
            }
        }

        results.push({
            filePath: s.filePath,
            project: s.project || "",
            sessionId: s.sessionId || basename(s.filePath, ".jsonl"),
            timestamp: firstTimestamp || new Date(),
            summary: s.summary ?? undefined,
            customTitle: s.customTitle ?? undefined,
            gitBranch: s.gitBranch ?? undefined,
            matchedMessages: [],
            isSubagent: s.isSubagent,
            relevanceScore: filters.query
                ? calculateRelevanceScore(
                      filters.query,
                      s.summary ?? undefined,
                      s.customTitle ?? undefined,
                      s.firstPrompt ?? undefined,
                      titleText,
                      firstTimestamp || new Date()
                  )
                : 0,
        });
    }

    if (filters.sortByRelevance) {
        results.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
    }

    return filters.limit ? results.slice(0, filters.limit) : results;
}

export async function searchConversations(filters: SearchFilters): Promise<SearchResult[]> {
    // Fast path: summary-only searches use SQLite cache (no JSONL parsing)
    if (filters.summaryOnly && !filters.commitHash && !filters.commitMessage) {
        return searchSessionMetadataCache(filters);
    }

    let results: SearchResult[] = [];
    const files = await findConversationFiles(filters);
    const total = files.length;
    let processed = 0;

    for (const filePath of files) {
        processed++;
        filters.onProgress?.(processed, total, basename(filePath, ".jsonl"));

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
                    ? calculateRelevanceScore(
                          filters.query,
                          summary,
                          customTitle,
                          firstUserMessage,
                          titleText,
                          firstTimestamp || new Date()
                      )
                    : 0,
            });
            continue;
        }

        // Commit hash search
        if (filters.commitHash) {
            const commitHashes = extractCommitHashes(messages);
            if (!commitHashes.some((h) => h.toLowerCase().startsWith(filters.commitHash!.toLowerCase()))) {
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
                matchedMessages: messages.filter((m) => m.type === "user" || m.type === "assistant"),
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
                            if (
                                cmd.includes("git commit") &&
                                cmd.toLowerCase().includes(filters.commitMessage.toLowerCase())
                            ) {
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
                matchedMessages: messages.filter((m) => m.type === "user" || m.type === "assistant"),
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
                    for (
                        let i = Math.max(0, idx - filters.context);
                        i <= Math.min(messages.length - 1, idx + filters.context);
                        i++
                    ) {
                        contextSet.add(i);
                    }
                }
                const sortedIndices = [...contextSet].sort((a, b) => a - b);
                contextMessages = sortedIndices.map((i) => messages[i]);
            }

            // Calculate relevance score
            const relevanceScore = filters.query
                ? calculateRelevanceScore(
                      filters.query,
                      summary,
                      customTitle,
                      firstUserMessage,
                      allText,
                      firstTimestamp || new Date()
                  )
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
            matchedMessages: messages.filter((m) => m.type === "user" || m.type === "assistant"),
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
// =============================================================================

export async function getAvailableProjects(): Promise<string[]> {
    // Use forward slash in glob pattern (glob normalizes paths)
    const dirs = await glob(`${PROJECTS_DIR}/*/`, { absolute: true });
    // extractProjectName handles OS-native separators from absolute paths
    return [...new Set(dirs.map((d) => extractProjectName(d)))].sort();
}

// =============================================================================
// Session Listing (cached, incremental)
// =============================================================================

export interface SessionListingOptions {
    /** Limit to specific project name (default: all) */
    project?: string;
    /** Exclude subagent sessions (default: true) */
    excludeSubagents?: boolean;
    /** Max results (default: unlimited) */
    limit?: number;
    /** Progress callback: (processed, total, currentFile) */
    onProgress?: (processed: number, total: number, currentFile: string) => void;
}

/**
 * Get a fast, cached listing of all sessions with metadata.
 * Uses SQLite cache with mtime-based incremental updates.
 * Only parses first ~30 lines of JSONL files for new/changed files.
 */
export interface SessionListingResult {
    sessions: SessionMetadataRecord[];
    total: number;
    subagents: number;
}

export async function getSessionListing(options: SessionListingOptions = {}): Promise<SessionListingResult> {
    const { excludeSubagents = true, limit } = options;

    // Resolve project to exact encoded dir path for precise scoping
    const projectDir = options.project ? resolveProjectDir(options.project) : undefined;

    // 1. Discover JSONL files (scoped to project dir if available)
    const files = projectDir
        ? await findConversationFilesInDir(projectDir, excludeSubagents)
        : await findConversationFiles({ excludeAgents: excludeSubagents });

    // 2. Incrementally index: only parse new/changed files
    const total = files.length;
    let processed = 0;
    for (const filePath of files) {
        processed++;
        try {
            const fileStat = await stat(filePath);
            const mtime = Math.floor(fileStat.mtimeMs);

            const cached = getSessionMetadata(filePath);
            if (cached && cached.mtime === mtime) continue;

            options.onProgress?.(processed, total, basename(filePath, ".jsonl"));

            const metadata = await extractSessionMetadataFromFile(filePath, mtime);
            if (metadata) {
                upsertSessionMetadata(metadata);
            }
        } catch {
            // Skip unreadable files
        }
    }

    // 3. Query cached metadata (scoped to the same files we just indexed)
    const all = projectDir
        ? getSessionMetadataByDir(projectDir)
        : getAllSessionMetadata();

    const subagentCount = all.filter((s) => s.isSubagent).length;
    const sessions = excludeSubagents ? all.filter((s) => !s.isSubagent) : all;

    sessions.sort((a, b) => {
        const ta = a.firstTimestamp ? new Date(a.firstTimestamp).getTime() : 0;
        const tb = b.firstTimestamp ? new Date(b.firstTimestamp).getTime() : 0;
        return tb - ta;
    });

    return {
        sessions: limit ? sessions.slice(0, limit) : sessions,
        total: all.length,
        subagents: subagentCount,
    };
}

/**
 * Resolve a project name (e.g. "GenesisTools") to its exact encoded dir path.
 * Falls back to glob matching if direct encoding doesn't exist.
 */
function resolveProjectDir(project: string): string | undefined {
    // Try exact cwd-based encoding first
    const cwd = process.cwd();
    const encoded = cwd.replaceAll("/", "-");
    const exact = resolve(PROJECTS_DIR, encoded);
    if (existsSync(exact)) return exact;

    // Fallback: find any dir ending with the project name
    try {
        const dirs = readdirSync(PROJECTS_DIR);
        const match = dirs.find((d) => d.endsWith(`-${project}`) || d === project);
        if (match) return resolve(PROJECTS_DIR, match);
    } catch {
        // ignore
    }
    return undefined;
}

/**
 * Find JSONL files in a specific project directory (fast, no glob).
 */
async function findConversationFilesInDir(projectDir: string, excludeSubagents: boolean): Promise<string[]> {
    try {
        const entries = readdirSync(projectDir);
        let files = entries
            .filter((e) => e.endsWith(".jsonl"))
            .map((e) => resolve(projectDir, e));

        if (excludeSubagents) {
            files = files.filter((f) => !basename(f).startsWith("agent-"));
        }
        return files;
    } catch {
        return [];
    }
}

/**
 * Extract session metadata by reading only the first ~30 lines of a JSONL file.
 * Much faster than full parsing — only needs summary, custom-title, sessionId, gitBranch, cwd.
 */
async function extractSessionMetadataFromFile(
    filePath: string,
    mtime: number
): Promise<SessionMetadataRecord | null> {
    const project = extractProjectName(filePath);
    const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

    try {
        const fileStream = createReadStream(filePath, { end: 64 * 1024 }); // Read max 64KB
        const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY });

        let sessionId: string | null = null;
        let customTitle: string | null = null;
        let summary: string | null = null;
        let firstPrompt: string | null = null;
        let gitBranch: string | null = null;
        let cwd: string | null = null;
        let firstTimestamp: string | null = null;
        let lineCount = 0;

        for await (const line of rl) {
            if (!line.trim()) continue;
            if (++lineCount > 50) break; // Only read first 50 lines

            try {
                const obj = JSON.parse(line);
                if (obj.type === "summary" && obj.summary) {
                    summary = obj.summary;
                }
                if (obj.type === "custom-title" && obj.customTitle) {
                    customTitle = obj.customTitle;
                }
                if (obj.sessionId && !sessionId) {
                    sessionId = obj.sessionId;
                }
                if (obj.gitBranch && !gitBranch) {
                    gitBranch = obj.gitBranch;
                }
                if (obj.cwd && !cwd) {
                    cwd = obj.cwd;
                }
                if (obj.timestamp && !firstTimestamp) {
                    firstTimestamp = obj.timestamp;
                }
                // Get first user prompt
                if (obj.type === "user" && !firstPrompt) {
                    if (typeof obj.message?.content === "string") {
                        firstPrompt = obj.message.content.slice(0, 120);
                    } else if (Array.isArray(obj.message?.content)) {
                        const textBlock = obj.message.content.find(
                            (b: { type: string }) => b.type === "text"
                        );
                        if (textBlock?.text) {
                            firstPrompt = textBlock.text.slice(0, 120);
                        }
                    }
                }
            } catch {
                // Skip unparseable lines
            }
        }

        // Fall back to filename as sessionId
        if (!sessionId) {
            sessionId = basename(filePath, ".jsonl");
        }

        return {
            filePath,
            sessionId,
            customTitle,
            summary,
            firstPrompt,
            gitBranch,
            project,
            cwd,
            mtime,
            firstTimestamp,
            isSubagent,
        };
    } catch {
        return null;
    }
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

export async function getConversationStats(): Promise<ConversationStats> {
    const files = await findConversationFiles({});

    const stats: ConversationStats = {
        totalConversations: 0,
        totalMessages: 0,
        projectCounts: {},
        toolCounts: {},
        dailyActivity: {},
        hourlyActivity: {},
        subagentCount: 0,
        tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
        },
        dailyTokens: {},
        modelCounts: {},
        branchCounts: {},
        conversationLengths: [],
    };

    for (const filePath of files) {
        const messages = await parseJsonlFile(filePath);
        if (messages.length === 0) continue;

        stats.totalConversations++;
        stats.totalMessages += messages.length;
        stats.conversationLengths.push(messages.length);

        const project = extractProjectName(filePath);
        stats.projectCounts[project] = (stats.projectCounts[project] || 0) + 1;

        const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");
        if (isSubagent) stats.subagentCount++;

        for (const msg of messages) {
            // Track daily and hourly activity
            if ("timestamp" in msg && msg.timestamp) {
                const date = new Date(msg.timestamp as string).toISOString().split("T")[0];
                const hour = new Date(msg.timestamp as string).getHours().toString();
                stats.dailyActivity[date] = (stats.dailyActivity[date] || 0) + 1;
                stats.hourlyActivity[hour] = (stats.hourlyActivity[hour] || 0) + 1;
            }

            // Track tool usage
            const toolUses = extractToolUses(msg);
            for (const tool of toolUses) {
                stats.toolCounts[tool.name] = (stats.toolCounts[tool.name] || 0) + 1;
            }

            // Track git branch
            if ("gitBranch" in msg && msg.gitBranch) {
                const branch = msg.gitBranch as string;
                stats.branchCounts[branch] = (stats.branchCounts[branch] || 0) + 1;
            }

            // Extract token usage and model from assistant messages
            if (msg.type === "assistant") {
                const assistantMsg = msg as AssistantMessage;
                const msgData = assistantMsg.message as {
                    model?: string;
                    usage?: {
                        input_tokens?: number;
                        output_tokens?: number;
                        cache_creation_input_tokens?: number;
                        cache_read_input_tokens?: number;
                    };
                };

                // Track model usage
                if (msgData.model) {
                    const modelName = extractModelName(msgData.model);
                    stats.modelCounts[modelName] = (stats.modelCounts[modelName] || 0) + 1;
                }

                // Track token usage
                if (msgData.usage) {
                    stats.tokenUsage.inputTokens += msgData.usage.input_tokens || 0;
                    stats.tokenUsage.outputTokens += msgData.usage.output_tokens || 0;
                    stats.tokenUsage.cacheCreateTokens += msgData.usage.cache_creation_input_tokens || 0;
                    stats.tokenUsage.cacheReadTokens += msgData.usage.cache_read_input_tokens || 0;

                    // Track daily tokens
                    if ("timestamp" in msg && msg.timestamp) {
                        const date = new Date(msg.timestamp as string).toISOString().split("T")[0];
                        if (!stats.dailyTokens[date]) {
                            stats.dailyTokens[date] = {
                                inputTokens: 0,
                                outputTokens: 0,
                                cacheCreateTokens: 0,
                                cacheReadTokens: 0,
                            };
                        }
                        stats.dailyTokens[date].inputTokens += msgData.usage.input_tokens || 0;
                        stats.dailyTokens[date].outputTokens += msgData.usage.output_tokens || 0;
                        stats.dailyTokens[date].cacheCreateTokens += msgData.usage.cache_creation_input_tokens || 0;
                        stats.dailyTokens[date].cacheReadTokens += msgData.usage.cache_read_input_tokens || 0;
                    }
                }
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

// =============================================================================
// Cached Statistics
// =============================================================================

export interface FileStats {
    conversations: number;
    messages: number;
    subagentSessions: number;
    toolCounts: Record<string, number>;
    dailyActivity: Record<string, number>;
    hourlyActivity: Record<string, number>;
    tokenUsage: TokenUsage;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
    firstDate: string | null;
    lastDate: string | null;
}

/**
 * Extract model name from full model ID (e.g., "claude-opus-4-5-20251101" -> "opus")
 */
function extractModelName(modelId: string): string {
    if (modelId.includes("opus")) return "opus";
    if (modelId.includes("sonnet")) return "sonnet";
    if (modelId.includes("haiku")) return "haiku";
    return "other";
}

/**
 * Compute stats for a single JSONL file
 */
export async function computeFileStats(filePath: string): Promise<FileStats> {
    const messages = await parseJsonlFile(filePath);
    const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

    const stats: FileStats = {
        conversations: 1,
        messages: messages.length,
        subagentSessions: isSubagent ? 1 : 0,
        toolCounts: {},
        dailyActivity: {},
        hourlyActivity: {},
        tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
        },
        modelCounts: {},
        branchCounts: {},
        firstDate: null,
        lastDate: null,
    };

    let minDate: string | null = null;
    let maxDate: string | null = null;

    for (const msg of messages) {
        // Track daily activity
        if ("timestamp" in msg && msg.timestamp) {
            const dateStr = new Date(msg.timestamp as string).toISOString().split("T")[0];
            const hour = new Date(msg.timestamp as string).getHours().toString();

            stats.dailyActivity[dateStr] = (stats.dailyActivity[dateStr] || 0) + 1;
            stats.hourlyActivity[hour] = (stats.hourlyActivity[hour] || 0) + 1;

            if (!minDate || dateStr < minDate) minDate = dateStr;
            if (!maxDate || dateStr > maxDate) maxDate = dateStr;
        }

        // Track tool usage
        const toolUses = extractToolUses(msg);
        for (const tool of toolUses) {
            stats.toolCounts[tool.name] = (stats.toolCounts[tool.name] || 0) + 1;
        }

        // Track git branch
        if ("gitBranch" in msg && msg.gitBranch) {
            const branch = msg.gitBranch as string;
            stats.branchCounts[branch] = (stats.branchCounts[branch] || 0) + 1;
        }

        // Extract token usage and model from assistant messages
        if (msg.type === "assistant") {
            const assistantMsg = msg as AssistantMessage;
            const msgData = assistantMsg.message as {
                model?: string;
                usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_creation_input_tokens?: number;
                    cache_read_input_tokens?: number;
                };
            };

            // Track model usage
            if (msgData.model) {
                const modelName = extractModelName(msgData.model);
                stats.modelCounts[modelName] = (stats.modelCounts[modelName] || 0) + 1;
            }

            // Track token usage
            if (msgData.usage) {
                stats.tokenUsage.inputTokens += msgData.usage.input_tokens || 0;
                stats.tokenUsage.outputTokens += msgData.usage.output_tokens || 0;
                stats.tokenUsage.cacheCreateTokens += msgData.usage.cache_creation_input_tokens || 0;
                stats.tokenUsage.cacheReadTokens += msgData.usage.cache_read_input_tokens || 0;
            }
        }
    }

    stats.firstDate = minDate;
    stats.lastDate = maxDate;

    return stats;
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
    const result = { ...a };
    for (const [key, value] of Object.entries(b)) {
        result[key] = (result[key] || 0) + value;
    }
    return result;
}

function mergeTokenUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
    return {
        inputTokens: (a?.inputTokens || 0) + b.inputTokens,
        outputTokens: (a?.outputTokens || 0) + b.outputTokens,
        cacheCreateTokens: (a?.cacheCreateTokens || 0) + b.cacheCreateTokens,
        cacheReadTokens: (a?.cacheReadTokens || 0) + b.cacheReadTokens,
    };
}

/**
 * Process a file and update cache incrementally
 */
export async function processFileForCache(filePath: string): Promise<FileStats | null> {
    try {
        const fileStat = await stat(filePath);
        const mtime = Math.floor(fileStat.mtimeMs);
        const project = extractProjectName(filePath);
        const isSubagent = filePath.includes("/subagents/") || basename(filePath).startsWith("agent-");

        // Check if file is already indexed
        const existing = getFileIndex(filePath);

        // File unchanged, skip processing
        if (existing && existing.mtime === mtime) {
            return null;
        }

        // File was modified (mtime changed) - invalidate old date range before re-processing
        if (existing && existing.mtime !== mtime) {
            invalidateDateRange(existing.firstDate, existing.lastDate);
        }

        // Compute stats for this file
        const fileStats = await computeFileStats(filePath);

        // Update file index
        upsertFileIndex({
            filePath,
            mtime,
            messageCount: fileStats.messages,
            firstDate: fileStats.firstDate,
            lastDate: fileStats.lastDate,
            project,
            isSubagent,
            lastIndexed: new Date().toISOString(),
        });

        // Update daily stats for each date in this file
        for (const [dateStr, messageCount] of Object.entries(fileStats.dailyActivity)) {
            const existingDaily = getDailyStats(dateStr);
            const toolCountsForDate: Record<string, number> = {};

            // Distribute tool counts proportionally (simplified: assign to first date)
            if (dateStr === fileStats.firstDate) {
                Object.assign(toolCountsForDate, fileStats.toolCounts);
            }

            const hourlyForDate: Record<string, number> = {};
            if (dateStr === fileStats.firstDate) {
                Object.assign(hourlyForDate, fileStats.hourlyActivity);
            }

            // Token, model, and branch data - assign to first date of file
            const tokenForDate: TokenUsage =
                dateStr === fileStats.firstDate
                    ? fileStats.tokenUsage
                    : { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 };

            const modelCountsForDate: Record<string, number> =
                dateStr === fileStats.firstDate ? fileStats.modelCounts : {};

            const branchCountsForDate: Record<string, number> =
                dateStr === fileStats.firstDate ? fileStats.branchCounts : {};

            const newDaily: DailyStats = {
                date: dateStr,
                project: "__all__",
                conversations: (existingDaily?.conversations || 0) + (dateStr === fileStats.firstDate ? 1 : 0),
                messages: (existingDaily?.messages || 0) + messageCount,
                subagentSessions:
                    (existingDaily?.subagentSessions || 0) + (dateStr === fileStats.firstDate && isSubagent ? 1 : 0),
                toolCounts: mergeCounts(existingDaily?.toolCounts || {}, toolCountsForDate),
                hourlyActivity: mergeCounts(existingDaily?.hourlyActivity || {}, hourlyForDate),
                tokenUsage: mergeTokenUsage(existingDaily?.tokenUsage, tokenForDate),
                modelCounts: mergeCounts(existingDaily?.modelCounts || {}, modelCountsForDate),
                branchCounts: mergeCounts(existingDaily?.branchCounts || {}, branchCountsForDate),
            };

            upsertDailyStats(newDaily);
        }

        return fileStats;
    } catch (error) {
        console.error(`Error processing file ${filePath}:`, error);
        return null;
    }
}

/**
 * Get conversation stats using cache (incremental updates)
 * @param options.forceRefresh - Force full re-scan (ignores cache)
 * @param options.dateRange - Optional date range to limit results
 * @param options.onProgress - Callback for progress updates
 */
export async function getConversationStatsWithCache(
    options: {
        forceRefresh?: boolean;
        dateRange?: DateRange;
        onProgress?: (processed: number, total: number, currentDate?: string) => void;
    } = {}
): Promise<ConversationStats> {
    const { forceRefresh = false, dateRange, onProgress } = options;

    // If forcing refresh, invalidate today's cache
    if (forceRefresh) {
        _invalidateToday();
    }

    // Get all conversation files
    const files = await findConversationFiles({});
    const totalFiles = files.length;

    // Get cached dates to know what we already have
    const cachedDates = new Set(getCachedDates());
    const today = new Date().toISOString().split("T")[0];

    // Always invalidate today since it might have new data
    cachedDates.delete(today);

    // Process files that need updating
    let processed = 0;
    for (const filePath of files) {
        const fileStats = await processFileForCache(filePath);
        processed++;

        if (onProgress && fileStats) {
            onProgress(processed, totalFiles, fileStats.firstDate || undefined);
        }
    }

    // Update last full update timestamp
    setCacheMeta("last_full_update", new Date().toISOString());

    // Get all daily stats (or filtered by date range)
    const dailyStats = getDailyStatsInRange(dateRange || {});

    // Aggregate into final stats
    const aggregated = aggregateDailyStats(dailyStats);

    // Get project counts from file index
    const db = getDatabase();
    const projectRows = db
        .query(
            `
    SELECT project, COUNT(*) as count
    FROM file_index
    WHERE project IS NOT NULL
    GROUP BY project
    ORDER BY count DESC
  `
        )
        .all() as Array<{ project: string; count: number }>;

    const projectCounts: Record<string, number> = {};
    for (const row of projectRows) {
        projectCounts[row.project] = row.count;
    }

    // Update totals cache
    updateCachedTotals({
        totalConversations: aggregated.totalConversations,
        totalMessages: aggregated.totalMessages,
        totalSubagents: aggregated.subagentCount,
        projectCount: Object.keys(projectCounts).length,
    });

    // Get conversation lengths for histogram
    const conversationLengths = await getConversationLengths();

    return {
        totalConversations: aggregated.totalConversations,
        totalMessages: aggregated.totalMessages,
        projectCounts,
        toolCounts: aggregated.toolCounts,
        dailyActivity: aggregated.dailyActivity,
        hourlyActivity: aggregated.hourlyActivity,
        subagentCount: aggregated.subagentCount,
        tokenUsage: aggregated.tokenUsage,
        dailyTokens: aggregated.dailyTokens,
        modelCounts: aggregated.modelCounts,
        branchCounts: aggregated.branchCounts,
        conversationLengths,
    };
}

/**
 * Get conversation lengths for histogram
 */
async function getConversationLengths(): Promise<number[]> {
    const db = getDatabase();
    const rows = db
        .query("SELECT message_count FROM file_index WHERE message_count > 0 ORDER BY message_count")
        .all() as Array<{ message_count: number }>;
    return rows.map((r) => r.message_count);
}

/**
 * Get quick stats from cache (instant, no file scanning)
 * Returns null if cache is empty
 */
export function getQuickStatsFromCache(): {
    totalConversations: number;
    totalMessages: number;
    subagentCount: number;
    projectCount: number;
} | null {
    const totals = getCachedTotals();
    if (!totals) return null;

    return {
        totalConversations: totals.totalConversations,
        totalMessages: totals.totalMessages,
        subagentCount: totals.totalSubagents,
        projectCount: totals.projectCount,
    };
}

/**
 * Get stats for a specific date range from cache
 * Fast if data is already cached, triggers background processing if not
 */
export async function getStatsForDateRange(range: DateRange): Promise<ConversationStats> {
    // First try to get from cache
    const dailyStats = getDailyStatsInRange(range);

    if (dailyStats.length > 0) {
        const aggregated = aggregateDailyStats(dailyStats);

        // Get project counts filtered by date range (files whose date range overlaps with the query range)
        const db = getDatabase();
        const fromDate = range.from || "1970-01-01";
        const toDate = range.to || "9999-12-31";
        const projectRows = db
            .query(
                `
      SELECT project, COUNT(*) as count
      FROM file_index
      WHERE project IS NOT NULL
        AND NOT (last_date < ? OR first_date > ?)
      GROUP BY project
      ORDER BY count DESC
    `
            )
            .all(fromDate, toDate) as Array<{ project: string; count: number }>;

        const projectCounts: Record<string, number> = {};
        for (const row of projectRows) {
            projectCounts[row.project] = row.count;
        }

        // Get conversation lengths for histogram
        const conversationLengths = await getConversationLengths();

        return {
            totalConversations: aggregated.totalConversations,
            totalMessages: aggregated.totalMessages,
            projectCounts,
            toolCounts: aggregated.toolCounts,
            dailyActivity: aggregated.dailyActivity,
            hourlyActivity: aggregated.hourlyActivity,
            subagentCount: aggregated.subagentCount,
            tokenUsage: aggregated.tokenUsage,
            dailyTokens: aggregated.dailyTokens,
            modelCounts: aggregated.modelCounts,
            branchCounts: aggregated.branchCounts,
            conversationLengths,
        };
    }

    // No cached data, do full computation
    return getConversationStatsWithCache({ dateRange: range });
}

export type { DailyStats, DateRange, SessionMetadataRecord, TokenUsage } from "./cache";
// Re-export cache functions for external use
export { getCachedTotals, getCacheStats, invalidateToday } from "./cache";
