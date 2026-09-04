/**
 * Claude Code Conversation History Library
 * Reusable functions for searching and parsing conversation history
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import { createInterface } from "node:readline";
import { concurrentMap } from "@genesiscz/utils/async";
import { discoverSessionFiles, discoverSessionFilesInDir } from "@genesiscz/utils/claude/discovery";
import {
    invalidateToday as _invalidateToday,
    aggregateDailyStats,
    clearSessionMetadata,
    type DailyStats,
    type DateRange,
    getAllSessionMetadata,
    getCachedDates,
    getCachedTotals,
    getCacheMeta,
    getDailyStats,
    getDailyStatsInRange,
    getDatabase,
    getFileIndex,
    getSessionMetadataByDir,
    getSessionMetadataBySessionId,
    invalidateDateRange,
    removeSessionMetadataBatch,
    type SessionMetadataRecord,
    setCacheMeta,
    type TokenUsage,
    updateCachedTotals,
    upsertDailyStats,
    upsertFileIndex,
    upsertSessionMetadata,
} from "@genesiscz/utils/claude/history-cache";
import { extractProjectName, PROJECTS_DIR, resolveProjectDir } from "@genesiscz/utils/claude/projects";
import { isSubagentFile } from "@genesiscz/utils/claude/session.utils";
import { Executor } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { glob } from "glob";
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

/**
 * Auto-derived metadata version — hash of search.ts + cache.ts source.
 * When ANY extraction/cache logic changes, this hash changes, forcing re-index.
 * Falls back to "v1" in bundled environments where source files aren't on disk.
 */
function getMetadataVersion(): string {
    try {
        return createHash("md5")
            .update(readFileSync(new URL("./search.ts", import.meta.url), "utf-8"))
            .update(readFileSync(new URL("./cache.ts", import.meta.url), "utf-8"))
            .digest("hex")
            .slice(0, 8);
    } catch {
        return "v1";
    }
}

const METADATA_VERSION = getMetadataVersion();
const SEARCH_PARSE_CONCURRENCY = 16;

function hist() {
    return profiler.scope("claude-history");
}

function profileAll(): boolean {
    return profiler.detail === "all";
}

// Re-export for backward compatibility (constants now live in @app/utils/claude/projects)
export { CLAUDE_DIR, PROJECTS_DIR } from "@genesiscz/utils/claude/projects";

// =============================================================================
// File Discovery
// =============================================================================

export async function findConversationFiles(filters: SearchFilters): Promise<string[]> {
    const p = hist();
    const isAll = !filters.project || filters.project === "all";
    const sw = new Stopwatch();

    const files = await p.measureAsync("discover", () =>
        discoverSessionFiles({
            project: isAll ? undefined : filters.project,
            allProjects: isAll,
            subagentsOnly: filters.agentsOnly,
            excludeSubagents: filters.excludeAgents,
        })
    );
    const discoverMs = sw.elapsedMs;

    // Sort by modification time (most recent first)
    const fileStats = await p.measureAsync("stat-sort", async () => {
        const stats = await Promise.all(
            files.map(async (f) => {
                const fileStat = await stat(f);
                return { path: f, mtime: fileStat.mtime };
            })
        );
        stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        return stats;
    });

    logger.info(
        {
            project: isAll ? "all" : filters.project,
            isAll,
            fileCount: fileStats.length,
            discoverMs: Math.round(discoverMs),
            statSortMs: Math.round(sw.elapsedMs - discoverMs),
        },
        "findConversationFiles: completed"
    );

    return fileStats.map((f) => f.path);
}

// extractProjectName and resolveProjectNameFromEncoded are now in @app/utils/claude/projects
// Re-export for backward compatibility
export { extractProjectName } from "@genesiscz/utils/claude/projects";

// =============================================================================
// JSONL Parsing
// =============================================================================

export async function parseJsonlFile(filePath: string): Promise<ConversationMessage[]> {
    const run = async (): Promise<ConversationMessage[]> => {
        const messages: ConversationMessage[] = [];

        const fileStream = createReadStream(filePath);
        const rl = createInterface({
            input: fileStream,
            crlfDelay: Number.POSITIVE_INFINITY,
        });

        for await (const line of rl) {
            if (line.trim()) {
                try {
                    const parsed = SafeJSON.parse(line, { strict: true }) as ConversationMessage;
                    messages.push(parsed);
                } catch {
                    // Skip invalid JSON lines
                }
            }
        }

        return messages;
    };

    if (profileAll()) {
        return hist().measureAsync("parseJsonl", run);
    }

    return run();
}

// =============================================================================
// Text Extraction & Matching
// =============================================================================

const TOOL_INPUT_FIELD_CAP = 2000;
const TOOL_INPUT_TOTAL_CAP = 8000;

/** Flatten string values from a tool_use.input object (paths, command, content, …). */
export function extractToolInputText(input: Record<string, unknown>): string {
    const parts: string[] = [];
    let total = 0;

    const visit = (value: unknown): void => {
        if (total >= TOOL_INPUT_TOTAL_CAP) {
            return;
        }

        if (typeof value === "string") {
            const slice = value.length > TOOL_INPUT_FIELD_CAP ? value.slice(0, TOOL_INPUT_FIELD_CAP) : value;
            parts.push(slice);
            total += slice.length;
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item);
            }

            return;
        }

        if (value && typeof value === "object") {
            for (const nested of Object.values(value as Record<string, unknown>)) {
                visit(nested);
            }
        }
    };

    visit(input);
    return parts.join(" ");
}

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
                } else if (block.type === "tool_use") {
                    texts.push(block.name);
                    texts.push(extractToolInputText(block.input));
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
    if (message.type !== "assistant") {
        return [];
    }

    const assistantMsg = message as AssistantMessage;
    if (!Array.isArray(assistantMsg.message?.content)) {
        return [];
    }

    return assistantMsg.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function extractFilePaths(message: ConversationMessage): string[] {
    const paths: string[] = [];
    const toolUses = extractToolUses(message);

    for (const tool of toolUses) {
        if (tool.input && typeof tool.input === "object") {
            // Common file path field names
            const fileFields = ["file_path", "path", "filePath", "notebook_path"];
            for (const field of fileFields) {
                if (field in tool.input && typeof tool.input[field] === "string") {
                    paths.push(tool.input[field] as string);
                }
            }
        }
    }

    return paths;
}

export function filePatterns(filters: SearchFilters): string[] {
    const patterns: string[] = [];

    if (filters.file) {
        patterns.push(filters.file);
    }

    if (filters.files) {
        for (const pattern of filters.files) {
            if (pattern) {
                patterns.push(pattern);
            }
        }
    }

    return patterns;
}

function matchFilePattern(haystackLower: string, pattern: string): boolean {
    const filePattern = pattern.toLowerCase();

    if (filePattern.includes("*")) {
        const regexPattern = filePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        if (!isSafeRegex(regexPattern)) {
            return false;
        }

        try {
            return new RegExp(regexPattern, "i").test(haystackLower);
        } catch {
            return false;
        }
    }

    return haystackLower.includes(filePattern);
}

/**
 * Check if a regex pattern is safe from ReDoS attacks.
 * Rejects patterns with nested quantifiers and excessive length.
 */
function isSafeRegex(pattern: string): boolean {
    // Reject excessively long patterns
    if (pattern.length > 200) {
        return false;
    }
    // Reject patterns with nested quantifiers (e.g., (a+)+ or (a*)*b*)
    const nestedQuantifiers = /(\+|\*|\?|\{[\d,]+\})\s*\)?\s*(\+|\*|\?|\{[\d,]+\})/;
    if (nestedQuantifiers.test(pattern)) {
        return false;
    }
    return true;
}

export function matchesQuery(text: string, query: string, exact: boolean, regex: boolean): boolean {
    if (!query) {
        return true;
    }

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
    if (!query) {
        return 0;
    }

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
        // biome-ignore lint/suspicious/noAssignInExpressions: assignment in while loop for indexOf matching
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
    // Match contexts where commit hashes appear:
    // - "git commit" / "committed" / "Commit:" — commit commands/messages
    // - "[branch hash]" — git commit output format
    // - "hash msg" lines — git log --oneline format (7+ hex chars at start of line)
    const gitCommitPattern = /git commit|committed|Commit:|^\[[^\]]+\s+[a-f0-9]{7,40}\]|\b[a-f0-9]{7,40}\b\s+\S/im;

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

interface CommitInfo {
    fullHash: string;
}

/**
 * Use git log to resolve a commit hash prefix to the full hash.
 * Returns null if the hash can't be resolved (e.g., not in a git repo).
 */
async function getCommitInfo(hashPrefix: string): Promise<CommitInfo | null> {
    try {
        const exec = new Executor({ prefix: "git" });

        // Try git log first (works for reachable commits)
        const result = await exec.exec(["log", "--format=%H", "-1", hashPrefix]);
        const fullHash = result.success ? result.stdout.trim() : "";

        if (fullHash) {
            return { fullHash };
        }

        // Fallback: git show works for dangling objects (post-rebase, pre-gc)
        const showResult = await exec.exec(["show", "--format=%H", "--no-patch", hashPrefix]);
        const shownHash = showResult.success ? showResult.stdout.trim() : "";

        if (shownHash) {
            return { fullHash: shownHash };
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Process a single file for commit hash matching.
 * Shared between the cache-narrowed search and the fallback scan.
 */
async function processFileForCommit(
    filePath: string,
    hashLower: string,
    searchHash: string,
    fullHash: string | undefined,
    filters: SearchFilters
): Promise<SearchResult | null> {
    // Raw text pre-filter (case-insensitive) — skip files that can't contain the hash
    let raw: string;
    try {
        raw = await Bun.file(filePath).text();
    } catch {
        return null;
    }

    const rawLower = raw.toLowerCase();

    // Also check a short prefix — JSONL often has abbreviated hashes (e.g. 10-char from git reflog)
    // that won't match a full 40-char needle via includes()
    const shortHash = searchHash.slice(0, 8);

    if (
        !rawLower.includes(searchHash) &&
        (fullHash ? !rawLower.includes(hashLower) : true) &&
        !rawLower.includes(shortHash)
    ) {
        return null;
    }

    const messages = await parseJsonlFile(filePath);

    if (messages.length === 0) {
        return null;
    }

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

    if (filters.excludeCurrentSession && sessionId === filters.excludeCurrentSession) {
        return null;
    }

    // Apply conversationDate filters
    if (filters.conversationDate && firstTimestamp && firstTimestamp < filters.conversationDate) {
        return null;
    }

    if (filters.conversationDateUntil && firstTimestamp && firstTimestamp > filters.conversationDateUntil) {
        return null;
    }

    const commitHashes = extractCommitHashes(messages);

    if (
        !commitHashes.some((h) => {
            const hLower = h.toLowerCase();
            return hLower.startsWith(hashLower) || hashLower.startsWith(hLower);
        })
    ) {
        return null;
    }

    const project = extractProjectName(filePath);
    const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

    return {
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
    };
}

/**
 * The needle ripgrep narrows the corpus with, capped at 8 characters.
 *
 * Transcripts hold whatever `git log --oneline` printed, which is an
 * ABBREVIATED hash. A full 40-char SHA pasted from GitHub matched no file at
 * all, so the command answered "nothing found" for a commit that was in the
 * history. Eight characters is the same prefilter `processFileForCommit` uses,
 * so every file it would accept is in the candidate set; it re-checks each hit
 * against the full hash, so a shared prefix costs a parse, never a wrong match.
 */
export function commitRgNeedle(hashLower: string, fullHash: string | undefined): string {
    return (fullHash ?? hashLower).slice(0, 8);
}

/**
 * Fast commit hash search: git log resolves the prefix to a full hash, ripgrep
 * narrows the corpus to files that mention it, and only those get parsed.
 */
async function searchCommitHashFast(hashPrefix: string, filters: SearchFilters): Promise<SearchResult[]> {
    const hashLower = hashPrefix.toLowerCase();

    // Step 1: Resolve the full hash via git log
    const commitInfo = await getCommitInfo(hashPrefix);
    const fullHash = commitInfo?.fullHash?.toLowerCase();
    // Use full hash for text matching when available, otherwise the prefix
    const searchHash = fullHash || hashLower;
    // Only early-exit on exact 40-char hashes (prefixes could match across repos)
    const canEarlyExit = hashLower.length === 40 || (fullHash !== undefined && fullHash.length === 40);

    // Step 2: candidate files via ripgrep. Reading every transcript into memory
    // took 31s over 11 GB / 11.8k files (profiling log, 2026-09-03); rg -l over
    // the same corpus takes 0.3s. Word boundaries stay off: the needle sits
    // inside longer hashes.
    const project = filters.project && filters.project !== "all" ? filters.project : undefined;
    const needle = commitRgNeedle(hashLower, fullHash);
    const { files: rgFiles, failed } = await hist().measureAsync("commit.rg-candidates", () =>
        rgSearchFilesDetailed(needle, { project, noWordBoundary: true })
    );

    let candidateFiles: string[];

    if (failed) {
        candidateFiles = await findConversationFiles(filters);
        logger.debug(`Commit search: rg unavailable, scanning ${candidateFiles.length} files`);
    } else {
        candidateFiles = rgFiles.filter((filePath) => {
            const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

            if (filters.excludeAgents && isSubagent) {
                return false;
            }

            return !(filters.agentsOnly && !isSubagent);
        });
        logger.debug(`Commit search: rg narrowed ${needle} to ${candidateFiles.length} candidate files`);

        if (candidateFiles.length === 0) {
            logger.debug(`Commit search: no transcript mentions ${needle} — nothing to parse`);
        }
    }

    const results: SearchResult[] = [];
    const total = candidateFiles.length;
    let processed = 0;

    for (const filePath of candidateFiles) {
        processed++;
        filters.onProgress?.(processed, total, basename(filePath, ".jsonl"));

        const result = await processFileForCommit(filePath, hashLower, searchHash, fullHash, filters);

        if (result) {
            if (canEarlyExit) {
                return [result];
            }

            results.push(result);
        }
    }

    return filters.limit ? results.slice(0, filters.limit) : results;
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
        const toolFilter = filters.tool.toLowerCase();
        const toolUses = extractToolUses(message);
        const hasMatchingTool = toolUses.some((t) => t.name.toLowerCase().includes(toolFilter));
        if (!hasMatchingTool) {
            return false;
        }
    }

    const patterns = filePatterns(filters);
    if (patterns.length > 0) {
        const paths = extractFilePaths(message);
        const inputText = extractToolUses(message)
            .map((tool) => extractToolInputText(tool.input))
            .join(" ");
        const haystack = `${paths.join("\n")}\n${inputText}`.toLowerCase();
        const hasMatchingFile = patterns.some((pattern) => matchFilePattern(haystack, pattern));
        if (!hasMatchingFile) {
            return false;
        }
    }

    // Date filters
    if (filters.since || filters.until) {
        const msgTimestamp = "timestamp" in message ? new Date(message.timestamp as string) : null;
        if (msgTimestamp) {
            if (filters.since && msgTimestamp < filters.since) {
                return false;
            }
            if (filters.until && msgTimestamp > filters.until) {
                return false;
            }
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
    const projectFilter = filters.project?.toLowerCase();
    const all = projectFilter
        ? getAllSessionMetadata().filter((s) => s.project?.toLowerCase().includes(projectFilter))
        : getAllSessionMetadata();

    const results: SearchResult[] = [];

    for (const s of all) {
        if (filters.excludeAgents && s.isSubagent) {
            continue;
        }
        if (filters.agentsOnly && !s.isSubagent) {
            continue;
        }

        if (filters.excludeCurrentSession && s.sessionId === filters.excludeCurrentSession) {
            continue;
        }

        const firstTimestamp = s.firstTimestamp ? new Date(s.firstTimestamp) : undefined;
        if (filters.conversationDate && firstTimestamp && firstTimestamp < filters.conversationDate) {
            continue;
        }
        if (filters.conversationDateUntil && firstTimestamp && firstTimestamp > filters.conversationDateUntil) {
            continue;
        }

        // --since / --until were checked by the full matcher but NOT here, so
        // `--summary-only --since ...` returned sessions outside the range, as
        // did callers like resume that route through this cache (PR #343 review
        // t3 round 12). Same predicate the listing fast path uses, rather than a
        // third hand-rolled copy of the comparison.
        if (firstTimestamp && !listingPassesDate(firstTimestamp, filters)) {
            continue;
        }

        const allSearchText = [s.customTitle, s.summary, s.firstPrompt, s.allUserText].filter(Boolean).join(" ");
        if (filters.query && !matchesQuery(allSearchText, filters.query, !!filters.exact, !!filters.regex)) {
            continue;
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
                      allSearchText,
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

export function partitionSessionFiles(files: string[]): { mains: string[]; agents: string[] } {
    const mains: string[] = [];
    const agents: string[] = [];

    for (const filePath of files) {
        if (isSubagentFile(filePath)) {
            agents.push(filePath);
        } else {
            mains.push(filePath);
        }
    }

    return { mains, agents };
}

async function matchConversationFile(filePath: string, filters: SearchFilters): Promise<SearchResult | null> {
    const messages = await parseJsonlFile(filePath);
    if (messages.length === 0) {
        return null;
    }

    const project = extractProjectName(filePath);
    const isSubagent = isSubagentFile(filePath);
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

        if (msg.type === "user" && !firstUserMessage) {
            firstUserMessage = extractTextFromMessage(msg, true);
        }
    }

    if (filters.excludeCurrentSession && sessionId === filters.excludeCurrentSession) {
        return null;
    }

    if (filters.conversationDate && firstTimestamp && firstTimestamp < filters.conversationDate) {
        return null;
    }

    if (filters.conversationDateUntil && firstTimestamp && firstTimestamp > filters.conversationDateUntil) {
        return null;
    }

    if (filters.summaryOnly) {
        const titleText = customTitle || summary || "";
        if (filters.query && !matchesQuery(titleText, filters.query, !!filters.exact, !!filters.regex)) {
            return null;
        }

        return {
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
        };
    }

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

            if (foundCommitMsg) {
                break;
            }
        }

        if (!foundCommitMsg) {
            return null;
        }

        return {
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
        };
    }

    const matchedMessages: ConversationMessage[] = [];
    const matchedIndices: number[] = [];
    let allText = "";

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const text = extractTextFromMessage(msg, !!filters.excludeThinking);
        allText += ` ${text}`;

        if (matchesFilters(msg, filters, text)) {
            matchedMessages.push(msg);
            matchedIndices.push(i);
        }
    }

    if (matchedMessages.length === 0 && filters.query) {
        return null;
    }

    if (matchedMessages.length === 0 && (filePatterns(filters).length > 0 || filters.tool)) {
        return null;
    }

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

    return {
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
    };
}

export async function searchConversationFiles(
    files: string[],
    filters: SearchFilters,
    opts: { stopAfter?: number } = {}
): Promise<SearchResult[]> {
    if (files.length === 0) {
        return [];
    }

    const stopAfter = opts.stopAfter ?? Number.POSITIVE_INFINITY;
    if (stopAfter <= 0) {
        return [];
    }

    const results: SearchResult[] = [];
    const concurrency = Math.min(SEARCH_PARSE_CONCURRENCY, files.length);

    for (let i = 0; i < files.length && results.length < stopAfter; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const byPath = await concurrentMap({
            items: batch,
            concurrency: batch.length,
            fn: (filePath) => matchConversationFile(filePath, filters),
            onError: (filePath, error) => {
                logger.debug({ error, filePath }, "searchConversationFiles: file failed");
            },
        });

        for (const filePath of batch) {
            const hit = byPath.get(filePath);
            if (hit) {
                results.push(hit);
                if (results.length >= stopAfter) {
                    break;
                }
            }
        }
    }

    return results;
}

function rgPrefilterNeedle(filters: SearchFilters): string | undefined {
    if (filters.regex && filters.query) {
        return filters.query;
    }

    if (filters.query) {
        const words = filters.query.split(/\s+/).filter((word) => word.length >= 3);
        if (words.length === 0) {
            return undefined;
        }

        return [...words].sort((a, b) => b.length - a.length)[0];
    }

    const patterns = filePatterns(filters);
    if (patterns.length === 1) {
        const stripped = patterns[0].replace(/\*/g, "");
        return stripped.length >= 3 ? stripped : undefined;
    }

    if (filters.tool && filters.tool.length >= 3) {
        return filters.tool;
    }

    return undefined;
}

type SearchFileRow = { path: string; mtime: number; matchCount: number };

function toSearchFileRows(paths: string[]): SearchFileRow[] {
    return paths.map((path) => ({ path, mtime: 0, matchCount: 0 }));
}

async function resolveSearchFiles(
    filters: SearchFilters
): Promise<{ files: SearchFileRow[]; source: "rg" | "discover" | "rg-fallback" }> {
    const needle = rgPrefilterNeedle(filters);
    if (needle) {
        const regex = !!filters.regex && needle === filters.query;

        // PR #343 review t18/t25: `-w` makes the prefilter STRICTER than
        // matchesQuery, which accepts substrings — so a file containing only
        // "authenticate" never reached the matcher for the query "auth". Both
        // scans are otherwise identical (-F, -i, same glob, same tree), so the
        // widened one is a strict superset and running the boundary scan as well
        // just doubled the transcript-tree walk for nothing (review t21).
        const rgOptions = {
            project: filters.project,
            regex,
            count: !!filters.sortByRelevance,
            noWordBoundary: !regex,
        };
        const { files, failed, counts } = await rgSearchFilesDetailed(needle, rgOptions);

        if (!failed) {
            const stats = await Promise.all(
                files.map(async (path) => {
                    try {
                        const fileStat = await stat(path);
                        return {
                            path,
                            mtime: fileStat.mtimeMs,
                            matchCount: counts?.get(path) ?? 0,
                        };
                    } catch (error) {
                        logger.debug({ error, path }, "resolveSearchFiles: stat failed");
                        return null;
                    }
                })
            );
            const existing = stats.filter((row): row is SearchFileRow => row !== null);
            existing.sort((a, b) => b.mtime - a.mtime);
            return { files: existing, source: "rg" };
        }

        logger.warn("rg prefilter failed; falling back to full discovery");
        const discovered = await findConversationFiles(filters);
        return { files: toSearchFileRows(discovered), source: "rg-fallback" };
    }

    const discovered = await findConversationFiles(filters);
    return { files: toSearchFileRows(discovered), source: "discover" };
}

/**
 * The listing path reads cached metadata and applies only `since`/`until`. Any
 * filter it cannot evaluate must keep the search on the full-parse path, which
 * is where `matchConversationFile` applies them.
 *
 * PR #343 review t17: without the last three checks, `--exclude-current`,
 * `--exclude-session`, `--conv-date` and `--conv-date-until` silently returned
 * UNFILTERED results whenever no query was given.
 */
export function canUseMetadataListing(filters: SearchFilters): boolean {
    return (
        !filters.query &&
        filePatterns(filters).length === 0 &&
        !filters.tool &&
        !filters.commitMessage &&
        !filters.commitHash &&
        !filters.context &&
        !filters.excludeCurrentSession &&
        !filters.conversationDate &&
        !filters.conversationDateUntil
    );
}

function listingRecordToResult(record: SessionMetadataRecord): SearchResult {
    return {
        filePath: record.filePath,
        project: record.project || "",
        sessionId: record.sessionId || basename(record.filePath, ".jsonl"),
        timestamp: record.firstTimestamp ? new Date(record.firstTimestamp) : new Date(record.mtime),
        summary: record.summary ?? undefined,
        customTitle: record.customTitle ?? undefined,
        gitBranch: record.gitBranch ?? undefined,
        matchedMessages: [],
        isSubagent: record.isSubagent,
    };
}

export function listingStalePaths(opts: {
    cachedPaths: string[];
    diskFiles: Set<string>;
    projectDir?: string;
    excludeSubagents?: boolean;
    subagentsOnly?: boolean;
}): string[] {
    if (opts.excludeSubagents || opts.subagentsOnly) {
        return [];
    }

    const cachedPathsInScope = opts.projectDir
        ? opts.cachedPaths.filter((p) => p.startsWith(opts.projectDir + sep) || p === opts.projectDir)
        : opts.cachedPaths;

    return cachedPathsInScope.filter((p) => !opts.diskFiles.has(p));
}

export function listingIndexSlice<T extends { mtime: number }>(entries: T[], limit?: number): T[] {
    const sorted = [...entries].sort((a, b) => b.mtime - a.mtime);
    if (limit == null) {
        return sorted;
    }

    return sorted.slice(0, Math.max(20, limit * 4));
}

export function listingWavePlan(filters: SearchFilters): {
    excludeSubagents: boolean;
    needAgentFill: boolean;
    subagentsOnly: boolean;
} {
    if (filters.agentsOnly) {
        return { excludeSubagents: false, needAgentFill: false, subagentsOnly: true };
    }

    if (filters.excludeAgents) {
        return { excludeSubagents: true, needAgentFill: false, subagentsOnly: false };
    }

    return { excludeSubagents: true, needAgentFill: true, subagentsOnly: false };
}

export function listingPassesDate(timestamp: Date, filters: SearchFilters): boolean {
    if (filters.since && timestamp < filters.since) {
        return false;
    }

    if (filters.until && timestamp > filters.until) {
        return false;
    }

    return true;
}

export function relevanceParseCap(fileCount: number, limit?: number): number {
    const floor = Math.max(8, (limit ?? 20) * 2);
    return Math.min(fileCount, floor);
}

const RELEVANCE_MATCH_COUNT_CAP = 20;

export function selectRelevanceParseFiles(
    files: { path: string; mtime: number; matchCount?: number }[],
    limit?: number
): string[] {
    const cap = relevanceParseCap(files.length, limit);
    const cappedCount = (file: { matchCount?: number }): number =>
        Math.min(file.matchCount ?? 0, RELEVANCE_MATCH_COUNT_CAP);

    return [...files]
        .sort((a, b) => {
            const countDelta = cappedCount(b) - cappedCount(a);
            if (countDelta !== 0) {
                return countDelta;
            }

            return b.mtime - a.mtime;
        })
        .slice(0, cap)
        .map((file) => file.path);
}

/**
 * Does relevance actually ORDER this search? The flag alone does not decide it:
 * the query is optional, and `mergeSearchWaves` ranks by relevance only when
 * both are present. Exported and shared so the agent-wave cap and the merge
 * cannot answer this differently again (PR #343 review t2 round 7).
 */
export function ranksByRelevance(filters: { sortByRelevance?: boolean; query?: string }): boolean {
    return Boolean(filters.sortByRelevance && filters.query);
}

export function agentWaveStopAfter(opts: {
    limit?: number;
    mainHitCount: number;
    /**
     * The EFFECTIVE ranking mode, which is `sortByRelevance && query` — the same
     * predicate `mergeSearchWaves` is given. The flag alone is not enough: the
     * query is optional, so `history --sort-relevance` with no query merges in
     * time order, and reading the bare flag here dropped the remaining-slot
     * optimisation for a listing that never ranks globally (review t2 round 7).
     */
    sortByRelevance?: boolean;
}): number | undefined {
    if (opts.limit == null) {
        return undefined;
    }

    // Relevance is ranked GLOBALLY across both waves, so the agent candidates
    // must still be parsed when the mains already fill --limit; otherwise the
    // merge ranks a set that was truncated before it ever saw them, and a
    // stronger subagent can never outrank a weak main (PR #343 review t20).
    //
    // The remaining-slot optimisation predates that: it was correct while the
    // merge sorted each wave separately and concatenated, because then the
    // agents really were dropped. `sortByRelevance` was already a parameter
    // here but went unread, so the two fixes silently cancelled out.
    // mergeSearchWaves applies the limit after ranking, and the agent wave is
    // capped upstream, so this parses the capped candidate set, not the world.
    if (opts.sortByRelevance) {
        return undefined;
    }

    return Math.max(0, opts.limit - opts.mainHitCount);
}

export function agentFillListingOptions(project: string | undefined, remaining?: number): SessionListingOptions {
    return {
        project,
        excludeSubagents: false,
        subagentsOnly: true,
        limit: remaining,
    };
}

export function shouldLoadAgentListing(
    plan: { excludeSubagents: boolean; needAgentFill: boolean },
    mainCount: number,
    limit?: number
): boolean {
    if (!plan.needAgentFill) {
        return false;
    }

    if (limit == null) {
        return true;
    }

    return mainCount < limit;
}

export function mergeSearchWaves(
    mains: SearchResult[],
    agents: SearchResult[],
    opts: { limit?: number; sortByRelevance?: boolean } = {}
): SearchResult[] {
    const byRelevance = (a: SearchResult, b: SearchResult) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    const byTime = (a: SearchResult, b: SearchResult) => b.timestamp.getTime() - a.timestamp.getTime();
    const sortFn = opts.sortByRelevance ? byRelevance : byTime;
    // Relevance is a global ranking, so the waves merge BEFORE sorting — sorting
    // each and concatenating kept a weak main ahead of a stronger subagent, and
    // --limit then dropped the best match (PR #343 review t21). Time ordering
    // keeps the main-first shape on purpose: mains are the primary sessions.
    const merged = opts.sortByRelevance
        ? [...mains, ...agents].sort(sortFn)
        : [...mains].sort(sortFn).concat([...agents].sort(sortFn));

    if (opts.limit && merged.length > opts.limit) {
        return merged.slice(0, opts.limit);
    }

    return merged;
}

export async function searchConversations(filters: SearchFilters): Promise<SearchResult[]> {
    const p = hist();
    const sw = new Stopwatch();
    logger.info(
        {
            query: filters.query,
            project: filters.project ?? "all",
            summaryOnly: !!filters.summaryOnly,
            sortByRelevance: !!filters.sortByRelevance,
            commitHash: filters.commitHash,
            commitMessage: filters.commitMessage,
            limit: filters.limit,
        },
        "searchConversations: start"
    );

    // Fast path: summary-only searches use SQLite cache (no JSONL parsing)
    if (filters.summaryOnly && !filters.commitHash && !filters.commitMessage) {
        logger.info("searchConversations: fast path = summary-only SQLite cache");
        const r = p.measure("search.summary-cache", () => searchSessionMetadataCache(filters));
        logger.info(
            { fastPath: "summary-only", matched: r.length, elapsedMs: Math.round(sw.elapsedMs) },
            "searchConversations: done"
        );
        p.summary("searchConversations");
        return r;
    }

    // Fast path: commit hash search uses git log + cache + raw text scanning
    if (filters.commitHash) {
        logger.info("searchConversations: fast path = commit-hash");
        const hash = filters.commitHash;
        const r = await p.measureAsync("search.commit-hash", () => searchCommitHashFast(hash, filters));
        logger.info(
            { fastPath: "commit-hash", matched: r.length, elapsedMs: Math.round(sw.elapsedMs) },
            "searchConversations: done"
        );
        p.summary("searchConversations");
        return r;
    }

    if (canUseMetadataListing(filters)) {
        logger.info("searchConversations: fast path = session listing cache");
        const plan = listingWavePlan(filters);
        const project = !filters.project || filters.project === "all" ? undefined : filters.project;
        const listing = await p.measureAsync("search.listing", () =>
            getSessionListing({
                project,
                excludeSubagents: plan.excludeSubagents,
                subagentsOnly: plan.subagentsOnly,
                limit: filters.limit,
            })
        );
        let records = listing.sessions;
        if (filters.agentsOnly) {
            records = records.filter((s) => s.isSubagent);
        } else if (filters.excludeAgents) {
            records = records.filter((s) => !s.isSubagent);
        }

        const mapped = records.map(listingRecordToResult).filter((s) => listingPassesDate(s.timestamp, filters));
        const mains = mapped.filter((s) => !s.isSubagent);
        let agents = mapped.filter((s) => s.isSubagent);

        if (shouldLoadAgentListing(plan, mains.length, filters.limit)) {
            const remaining = filters.limit == null ? undefined : Math.max(0, filters.limit - mains.length);
            const agentListing = await p.measureAsync("search.listing-agents", () =>
                getSessionListing(agentFillListingOptions(project, remaining))
            );
            // The mains are filtered by listingPassesDate; without the same
            // predicate here, old or future subagents filled the remaining slots
            // in spite of --since/--until (PR #343 review t4).
            agents = agentListing.sessions
                .filter((s) => s.isSubagent)
                .map(listingRecordToResult)
                .filter((result) => listingPassesDate(result.timestamp, filters));
        }

        const results = mergeSearchWaves(mains, agents, {
            limit: filters.limit,
            sortByRelevance: false,
        });
        logger.info(
            {
                fastPath: "listing-cache",
                indexed: listing.indexed,
                mains: mains.length,
                agents: agents.length,
                matched: results.length,
                elapsedMs: Math.round(sw.elapsedMs),
            },
            "searchConversations: done"
        );
        p.summary("searchConversations");
        return results;
    }

    const resolved = await p.measureAsync("search.resolve-files", () => resolveSearchFiles(filters));
    const byPath = new Map(resolved.files.map((row) => [row.path, row]));
    const { mains, agents } = partitionSessionFiles(resolved.files.map((row) => row.path));
    let wave1 = filters.agentsOnly ? [] : mains;
    let wave2 = filters.excludeAgents ? [] : agents;

    if (filters.sortByRelevance) {
        const rowFor = (path: string): SearchFileRow => byPath.get(path) ?? { path, mtime: 0, matchCount: 0 };
        wave1 = selectRelevanceParseFiles(wave1.map(rowFor), filters.limit);
        wave2 = selectRelevanceParseFiles(wave2.map(rowFor), filters.limit);
    }

    logger.info(
        {
            fastPath: resolved.source,
            fileCount: resolved.files.length,
            mains: wave1.length,
            agents: wave2.length,
            findFilesMs: Math.round(sw.elapsedMs),
        },
        "searchConversations: parsing candidate files"
    );

    const stopMains = filters.sortByRelevance || filters.limit == null ? undefined : filters.limit;
    const mainHits = await p.measureAsync("search.wave-mains", () =>
        searchConversationFiles(wave1, filters, { stopAfter: stopMains })
    );
    const relevanceOrdered = ranksByRelevance(filters);
    const remaining = agentWaveStopAfter({
        limit: filters.limit,
        mainHitCount: mainHits.length,
        sortByRelevance: relevanceOrdered,
    });
    const agentHits = await p.measureAsync("search.wave-agents", () =>
        searchConversationFiles(wave2, filters, { stopAfter: remaining })
    );
    const results = mergeSearchWaves(mainHits, agentHits, {
        limit: filters.limit,
        sortByRelevance: relevanceOrdered,
    });

    logger.info(
        {
            fastPath: resolved.source,
            fileCount: resolved.files.length,
            mainsMatched: mainHits.length,
            agentsMatched: agentHits.length,
            matched: results.length,
            elapsedMs: Math.round(sw.elapsedMs),
            sortByRelevance: !!filters.sortByRelevance,
        },
        "searchConversations: done"
    );

    p.summary("searchConversations");
    return results;
}

/**
 * List conversation summaries (quick overview without full search)
 */
export async function listConversationSummaries(filters: SearchFilters): Promise<SearchResult[]> {
    const p = hist();
    const results: SearchResult[] = [];
    const files = await p.measureAsync("list-summaries.find-files", () => findConversationFiles(filters));

    for (const filePath of files) {
        const messages = await parseJsonlFile(filePath);
        if (messages.length === 0) {
            continue;
        }

        const project = extractProjectName(filePath);
        const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

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
            if (firstTimestamp < filters.conversationDate) {
                continue;
            }
        }
        if (filters.conversationDateUntil && firstTimestamp) {
            if (firstTimestamp > filters.conversationDateUntil) {
                continue;
            }
        }

        // Skip if no summary/title
        if (!summary && !customTitle) {
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
            matchedMessages: [],
            isSubagent,
        });

        if (filters.limit && results.length >= filters.limit) {
            break;
        }
    }

    p.summary("listConversationSummaries");
    return results;
}

// =============================================================================
// Metadata Extraction
// =============================================================================

export async function getConversationMetadata(filePath: string): Promise<ConversationMetadata> {
    const messages = await parseJsonlFile(filePath);
    const project = extractProjectName(filePath);
    const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

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
        if (messages.length === 0) {
            continue;
        }

        const project = extractProjectName(filePath);
        const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

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
            if (msg.type === "user") {
                userCount++;
            }
            if (msg.type === "assistant") {
                assistantCount++;
            }
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
    /** Discover subagent files only */
    subagentsOnly?: boolean;
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
    /** How many files were newly indexed or re-indexed this run */
    indexed: number;
    /** How many stale cache entries were cleaned up */
    staleRemoved: number;
    /** Whether a full re-index was triggered by version change */
    reindexed: boolean;
    /** Number of distinct projects found */
    projectCount: number;
    /** Scoped search directory (or "all projects") */
    scope: string;
}

export async function getSessionListing(options: SessionListingOptions = {}): Promise<SessionListingResult> {
    const p = hist();
    const { excludeSubagents = true, subagentsOnly = false, limit } = options;

    // Auto-reindex when extraction logic changes
    const cachedVersion = getCacheMeta("metadata_version");
    const reindexed = cachedVersion !== METADATA_VERSION;
    if (reindexed) {
        clearSessionMetadata();
        setCacheMeta("metadata_version", METADATA_VERSION);
    }

    // Resolve project to exact encoded dir path for precise scoping
    const projectDir = options.project ? resolveProjectDir(options.project) : undefined;
    const scope = projectDir ? options.project || projectDir.split(sep).pop() || "unknown" : "all projects";

    // 1. Discover JSONL files (scoped to project dir if available)
    //
    // `allProjects: true` is not optional here. Without it discoverSessionFiles falls
    // back to resolveProjectFilter(), so "no project" would silently mean "the current
    // directory's project" — the opposite of this option's documented default, and the
    // reason `--all-projects` returned only the local project's sessions.
    const files = await p.measureAsync("listing.discover", async () => {
        if (subagentsOnly) {
            return discoverSessionFiles({
                project: options.project,
                allProjects: !options.project,
                subagentsOnly: true,
            });
        }

        return projectDir
            ? discoverSessionFilesInDir(projectDir, { excludeSubagents })
            : await discoverSessionFiles({ excludeSubagents, allProjects: true });
    });

    // 2. Incrementally index: only parse new/changed files.
    // Stat every file in parallel. Sequential `await stat` was the sessions
    // JSON bottleneck (listingMs 5s+, tailMs ~1).
    const total = files.length;
    let processed = 0;
    let indexed = 0;
    const stats = await p.measureAsync("listing.stat", () =>
        Promise.all(
            files.map(async (filePath) => {
                try {
                    const fileStat = await stat(filePath);
                    return { filePath, mtime: Math.floor(fileStat.mtimeMs) };
                } catch {
                    return null;
                }
            })
        )
    );

    // One SELECT for the whole table instead of one query per file — the
    // per-file lookup was ~26ms of the listing across 1.3k files.
    const cachedByPath = new Map(getAllSessionMetadata().map((r) => [r.filePath, r]));
    const indexEntries = listingIndexSlice(
        stats.filter((entry): entry is { filePath: string; mtime: number } => entry !== null),
        limit
    );

    const indexEnd = p.start("listing.index");
    for (const entry of indexEntries) {
        processed++;
        const { filePath, mtime } = entry;
        const cached = cachedByPath.get(filePath);
        if (cached && cached.mtime === mtime) {
            continue;
        }

        options.onProgress?.(processed, total, basename(filePath, ".jsonl"));

        try {
            const metadata = await extractSessionMetadataFromFile(filePath, mtime);
            if (metadata) {
                upsertSessionMetadata(metadata);
                indexed++;
            }
        } catch {
            // Skip unreadable files
        }
    }

    indexEnd();

    // Clean up stale entries for deleted files (scoped to current listing)
    const diskFiles = new Set(files);
    const stalePaths = listingStalePaths({
        cachedPaths: [...cachedByPath.keys()],
        diskFiles,
        projectDir,
        excludeSubagents,
        subagentsOnly,
    });
    if (stalePaths.length > 0) {
        removeSessionMetadataBatch(stalePaths);
    }

    // 3. Query cached metadata (scoped to the same files we just indexed)
    const all = projectDir ? getSessionMetadataByDir(projectDir) : getAllSessionMetadata();

    const subagentCount = all.filter((s) => s.isSubagent).length;
    const sessions = excludeSubagents ? all.filter((s) => !s.isSubagent) : all;
    const projects = new Set(all.map((s) => s.project).filter(Boolean));

    sessions.sort((a, b) => {
        const ta = a.firstTimestamp ? new Date(a.firstTimestamp).getTime() : 0;
        const tb = b.firstTimestamp ? new Date(b.firstTimestamp).getTime() : 0;
        return tb - ta;
    });

    p.summary("getSessionListing");

    return {
        sessions: limit ? sessions.slice(0, limit) : sessions,
        total: all.length,
        subagents: subagentCount,
        indexed,
        staleRemoved: stalePaths.length,
        reindexed,
        projectCount: projects.size,
        scope,
    };
}

// resolveProjectDir and findConversationFilesInDir are now in shared modules
// (imported at top of file)

const METADATA_USER_TEXT_CAP = 5000;
const METADATA_LINE_LIMIT = 200;
const METADATA_TAIL_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;

interface MetadataScanState {
    sessionId: string | null;
    customTitle: string | null;
    summary: string | null;
    firstPrompt: string | null;
    gitBranch: string | null;
    cwd: string | null;
    firstTimestamp: string | null;
    userTexts: string[];
    userTextLen: number;
}

function createMetadataScanState(): MetadataScanState {
    return {
        sessionId: null,
        customTitle: null,
        summary: null,
        firstPrompt: null,
        gitBranch: null,
        cwd: null,
        firstTimestamp: null,
        userTexts: [],
        userTextLen: 0,
    };
}

function isMetadataScanComplete(state: MetadataScanState): boolean {
    return Boolean(
        state.summary &&
            state.customTitle &&
            state.sessionId &&
            state.gitBranch &&
            state.cwd &&
            state.firstTimestamp &&
            state.userTextLen >= METADATA_USER_TEXT_CAP
    );
}

// Applies one JSONL line to the scan state. custom-title/summary are "latest wins"
// (they're rewritten late in a session); everything else is "first wins".
function applyMetadataLine(line: string, state: MetadataScanState): void {
    if (!line.trim()) {
        return;
    }

    try {
        const obj = SafeJSON.parse(line, { strict: true });

        if (!obj || typeof obj !== "object") {
            return;
        }

        if (obj.type === "summary" && obj.summary) {
            state.summary = obj.summary;
        }
        if (obj.type === "custom-title" && obj.customTitle) {
            state.customTitle = obj.customTitle;
        }
        if (obj.sessionId && !state.sessionId) {
            state.sessionId = obj.sessionId;
        }
        if (obj.gitBranch && !state.gitBranch) {
            state.gitBranch = obj.gitBranch;
        }
        if (obj.cwd && !state.cwd) {
            state.cwd = obj.cwd;
        }
        if (obj.timestamp && !state.firstTimestamp) {
            state.firstTimestamp = obj.timestamp;
        }

        if (obj.type === "user" && state.userTextLen < METADATA_USER_TEXT_CAP) {
            let text = "";
            if (typeof obj.message?.content === "string") {
                text = obj.message.content;
            } else if (Array.isArray(obj.message?.content)) {
                const textBlock = obj.message.content.find((b: { type: string }) => b.type === "text");
                if (textBlock?.text) {
                    text = textBlock.text;
                }
            }
            if (text) {
                if (!state.firstPrompt) {
                    state.firstPrompt = text;
                }
                const remaining = METADATA_USER_TEXT_CAP - state.userTextLen;
                state.userTexts.push(text.slice(0, remaining));
                state.userTextLen += text.length;
            }
        }
    } catch {
        // Skip unparseable lines
    }
}

function findNthNewlineOffset(bytes: Uint8Array, n: number): number | null {
    let count = 0;
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === NEWLINE_BYTE) {
            count++;
            if (count === n) {
                return i;
            }
        }
    }
    return null;
}

// Scans metadata straight out of a mmap'd Uint8Array — only the pages actually
// sliced/decoded get paged in by the OS, so large files stay cheap.
function scanMetadataFromMmap(mapped: Uint8Array, isLargeFile: boolean): MetadataScanState {
    const state = createMetadataScanState();
    const decoder = new TextDecoder();

    let headEnd = mapped.length;
    let hitLimit = false;

    if (isLargeFile) {
        const offset = findNthNewlineOffset(mapped, METADATA_LINE_LIMIT);
        if (offset !== null && offset < mapped.length - 1) {
            headEnd = offset;
            hitLimit = true;
        }
    }

    const headLines = decoder.decode(mapped.subarray(0, headEnd)).split("\n");
    for (const line of headLines) {
        applyMetadataLine(line, state);
        if (isMetadataScanComplete(state)) {
            break;
        }
    }

    // For large files where we hit the line limit, scan the tail for
    // custom-title and summary — they're written late in the session
    if (isLargeFile && hitLimit && (!state.customTitle || !state.summary)) {
        const tailStart = Math.max(0, mapped.length - METADATA_TAIL_BYTES);
        const tailLines = decoder.decode(mapped.subarray(tailStart)).split("\n");

        // Skip the first (possibly partial) line when reading mid-file
        const linesToScan = tailStart > 0 ? tailLines.slice(1) : tailLines;
        for (const line of linesToScan) {
            applyMetadataLine(line, state);
        }
    }

    return state;
}

// Fallback path for filesystems where Bun.mmap throws (e.g. network mounts).
async function scanMetadataFromStream(
    filePath: string,
    fileSize: number,
    isLargeFile: boolean
): Promise<MetadataScanState> {
    const state = createMetadataScanState();
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Number.POSITIVE_INFINITY });

    const LINE_LIMIT = isLargeFile ? METADATA_LINE_LIMIT : Number.POSITIVE_INFINITY;
    let lineCount = 0;
    let hitLimit = false;

    for await (const line of rl) {
        if (!line.trim()) {
            continue;
        }

        lineCount++;
        if (lineCount > LINE_LIMIT) {
            hitLimit = true;
            break;
        }

        applyMetadataLine(line, state);

        if (isMetadataScanComplete(state)) {
            fileStream.destroy();
            break;
        }
    }

    if (isLargeFile && hitLimit && (!state.customTitle || !state.summary)) {
        try {
            const tailStart = Math.max(0, fileSize - METADATA_TAIL_BYTES);
            const tailStream = createReadStream(filePath, { start: tailStart });
            const tailRl = createInterface({ input: tailStream, crlfDelay: Number.POSITIVE_INFINITY });
            let firstLine = tailStart > 0;

            for await (const line of tailRl) {
                // Skip the first (possibly partial) line when reading mid-file
                if (firstLine) {
                    firstLine = false;
                    continue;
                }

                applyMetadataLine(line, state);
            }
        } catch {
            // Tail scan is best-effort
        }
    }

    return state;
}

/**
 * Extract session metadata by reading the entire JSONL file.
 * Captures: summary, custom-title, sessionId, gitBranch, cwd,
 * full first prompt, and all user message text (capped at 5000 chars).
 */
export async function extractSessionMetadataFromFile(
    filePath: string,
    mtime: number
): Promise<SessionMetadataRecord | null> {
    if (profileAll()) {
        return hist().measureAsync("extractSessionMetadata", () =>
            extractSessionMetadataFromFileUnprofiled(filePath, mtime)
        );
    }

    return extractSessionMetadataFromFileUnprofiled(filePath, mtime);
}

async function extractSessionMetadataFromFileUnprofiled(
    filePath: string,
    mtime: number
): Promise<SessionMetadataRecord | null> {
    const project = extractProjectName(filePath);
    const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

    try {
        // For large files, read only the first N lines to extract metadata
        const fileStat = await stat(filePath);
        const isLargeFile = fileStat.size > 10 * 1024 * 1024;

        let state: MetadataScanState | null = null;

        // Bun.mmap doesn't support empty files (throws EINVAL) — skip straight to the stream fallback
        if (fileStat.size > 0) {
            try {
                let mapped: Uint8Array | null = Bun.mmap(filePath);
                state = scanMetadataFromMmap(mapped, isLargeFile);
                mapped = null;
            } catch (err) {
                logger.debug(
                    { err, filePath },
                    "Bun.mmap failed for session metadata scan, falling back to stream read"
                );
            }
        }

        if (!state) {
            state = await scanMetadataFromStream(filePath, fileStat.size, isLargeFile);
        }

        const sessionId = state.sessionId ?? basename(filePath, ".jsonl");

        return {
            filePath,
            sessionId,
            customTitle: state.customTitle,
            summary: state.summary,
            firstPrompt: state.firstPrompt,
            gitBranch: state.gitBranch,
            project,
            cwd: state.cwd,
            mtime,
            firstTimestamp: state.firstTimestamp,
            isSubagent,
            allUserText: state.userTexts.length > 0 ? state.userTexts.join(" ") : null,
        };
    } catch {
        return null;
    }
}

// =============================================================================
// Ripgrep Full-Content Search
// =============================================================================

/** Word-shaped needles use rg -w so JSON keys like sessionId are not file hits. */
export function rgNeedleUsesWordBoundary(query: string): boolean {
    return /^[A-Za-z0-9_]+$/.test(query);
}

/**
 * Use ripgrep to find JSONL files containing a query string.
 * Returns file paths of matching sessions — extremely fast.
 */
export async function rgSearchFiles(
    query: string,
    options: { project?: string; limit?: number; dir?: string } = {}
): Promise<string[]> {
    return hist().measureAsync("rgSearchFiles", () => rgSearchFilesUnprofiled(query, options));
}

function parseRgCountLine(line: string): { path: string; count: number } | null {
    const idx = line.lastIndexOf(":");
    if (idx <= 0) {
        return null;
    }

    const count = Number(line.slice(idx + 1));
    if (!Number.isFinite(count)) {
        return null;
    }

    return { path: line.slice(0, idx), count };
}

async function rgSearchFilesDetailed(
    query: string,
    options: {
        project?: string;
        limit?: number;
        regex?: boolean;
        dir?: string;
        count?: boolean;
        noWordBoundary?: boolean;
    } = {}
): Promise<{ files: string[]; failed: boolean; counts?: Map<string, number> }> {
    const searchDir = options.dir
        ? options.dir
        : options.project
          ? resolveProjectDir(options.project) || PROJECTS_DIR
          : PROJECTS_DIR;
    const rg = new Executor({ prefix: ripgrepBinary() ?? "rg" });
    const args = options.count
        ? ["-c", "--glob", "*.jsonl", "-i", "--max-count", String(RELEVANCE_MATCH_COUNT_CAP)]
        : ["-l", "--glob", "*.jsonl", "-i", "--max-count", "1"];

    if (!options.regex) {
        args.push("-F");
        if (rgNeedleUsesWordBoundary(query) && !options.noWordBoundary) {
            args.push("-w");
        }
    }

    args.push("--", query, searchDir);

    try {
        const { stdout, stderr, exitCode } = await rg.exec(args);

        if (exitCode > 1) {
            logger.warn(`rgSearchFiles failed (exit ${exitCode}): ${stderr}`);
            return { files: [], failed: true };
        }

        const lines = stdout.split("\n").filter(Boolean);
        if (options.count) {
            const counts = new Map<string, number>();
            const files: string[] = [];
            for (const line of lines) {
                const parsed = parseRgCountLine(line);
                if (!parsed) {
                    continue;
                }

                files.push(parsed.path);
                counts.set(parsed.path, parsed.count);
            }

            return { files, failed: false, counts };
        }

        let files = lines;
        if (options.limit && files.length > options.limit) {
            files = files.slice(0, options.limit);
        }

        return { files, failed: false };
    } catch (error) {
        logger.warn(`rgSearchFiles error: ${error}`);
        return { files: [], failed: true };
    }
}

async function rgSearchFilesUnprofiled(
    query: string,
    options: { project?: string; limit?: number; dir?: string } = {}
): Promise<string[]> {
    const { files } = await rgSearchFilesDetailed(query, options);
    return files;
}

/**
 * Use ripgrep to extract a snippet around the first match in a file.
 */
export async function rgExtractSnippet(query: string, filePath: string): Promise<string | undefined> {
    try {
        const rg = new Executor({ prefix: ripgrepBinary() ?? "rg" });
        const { stdout, exitCode } = await rg.exec([
            "-i",
            "-F",
            "-m",
            "1",
            "--no-filename",
            "--no-line-number",
            "--",
            query,
            filePath,
        ]);

        if (exitCode > 1) {
            return undefined;
        }

        const line = stdout;
        if (!line) {
            return undefined;
        }

        // Try to extract readable text from the JSON line
        try {
            const obj = SafeJSON.parse(line, { strict: true });
            const text = extractTextFromMessage(obj as ConversationMessage, true);

            if (!text) {
                return undefined;
            }

            const lowerText = text.toLowerCase();
            const lowerQuery = query.toLowerCase();
            const idx = lowerText.indexOf(lowerQuery);
            if (idx === -1) {
                return text.slice(0, 100);
            }

            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + query.length + 60);
            return (
                (start > 0 ? "..." : "") +
                text.slice(start, end).replace(/\n/g, " ").trim() +
                (end < text.length ? "..." : "")
            );
        } catch {
            // If JSON parsing fails, try to extract from raw text
            const lowerLine = line.toLowerCase();
            const lowerQuery = query.toLowerCase();
            const idx = lowerLine.indexOf(lowerQuery);
            if (idx === -1) {
                return undefined;
            }

            const start = Math.max(0, idx - 40);
            const end = Math.min(line.length, idx + query.length + 60);
            return `...${line.slice(start, end).replace(/\\n/g, " ").trim()}...`;
        }
    } catch {
        return undefined;
    }
}

// =============================================================================
// Get Conversation by Session ID
// =============================================================================

function buildSearchResultFromMessages(filePath: string, messages: ConversationMessage[]): SearchResult | null {
    if (messages.length === 0) {
        return null;
    }

    const project = extractProjectName(filePath);
    const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");
    const fileName = basename(filePath, ".jsonl");

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

export async function getConversationBySessionId(sessionId: string): Promise<SearchResult | null> {
    const cached = getSessionMetadataBySessionId(sessionId);

    if (cached) {
        const messages = await parseJsonlFile(cached.filePath);
        return buildSearchResultFromMessages(cached.filePath, messages);
    }

    const files = await findConversationFiles({});

    for (const filePath of files) {
        const fileName = basename(filePath, ".jsonl");

        if (fileName !== sessionId) {
            continue;
        }

        const messages = await parseJsonlFile(filePath);
        return buildSearchResultFromMessages(filePath, messages);
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
    const p = hist();
    const files = await p.measureAsync("stats-uncached.find-files", () => findConversationFiles({}));

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
        if (messages.length === 0) {
            continue;
        }

        stats.totalConversations++;
        stats.totalMessages += messages.length;
        stats.conversationLengths.push(messages.length);

        const project = extractProjectName(filePath);
        stats.projectCounts[project] = (stats.projectCounts[project] || 0) + 1;

        const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");
        if (isSubagent) {
            stats.subagentCount++;
        }

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

    p.summary("getConversationStats");

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
    if (modelId.includes("opus")) {
        return "opus";
    }
    if (modelId.includes("sonnet")) {
        return "sonnet";
    }
    if (modelId.includes("haiku")) {
        return "haiku";
    }
    return "other";
}

/**
 * Compute stats for a single JSONL file
 */
export async function computeFileStats(filePath: string): Promise<FileStats> {
    const messages = await parseJsonlFile(filePath);
    const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

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

            if (!minDate || dateStr < minDate) {
                minDate = dateStr;
            }
            if (!maxDate || dateStr > maxDate) {
                maxDate = dateStr;
            }
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
    if (profileAll()) {
        return hist().measureAsync("processFileForCache", () => processFileForCacheUnprofiled(filePath));
    }

    return processFileForCacheUnprofiled(filePath);
}

async function processFileForCacheUnprofiled(filePath: string): Promise<FileStats | null> {
    try {
        const fileStat = await stat(filePath);
        const mtime = Math.floor(fileStat.mtimeMs);
        const project = extractProjectName(filePath);
        const isSubagent = filePath.includes(`${sep}subagents${sep}`) || basename(filePath).startsWith("agent-");

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
        out.error(`Error processing file ${filePath}:`, error);
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
    const p = hist();
    const { forceRefresh = false, dateRange, onProgress } = options;

    // If forcing refresh, invalidate today's cache
    if (forceRefresh) {
        _invalidateToday();
    }

    // Get all conversation files
    const files = await p.measureAsync("stats.find-files", () => findConversationFiles({}));
    const totalFiles = files.length;

    // Get cached dates to know what we already have
    const cachedDates = new Set(getCachedDates());
    const today = new Date().toISOString().split("T")[0];

    // Always invalidate today since it might have new data
    cachedDates.delete(today);

    // Process files that need updating
    let processed = 0;
    const processEnd = p.start("stats.process-files");
    for (const filePath of files) {
        const fileStats = await processFileForCache(filePath);
        processed++;

        if (onProgress && fileStats) {
            onProgress(processed, totalFiles, fileStats.firstDate || undefined);
        }
    }

    processEnd();

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
    const conversationLengths = await p.measureAsync("stats.lengths", () => getConversationLengths());

    p.summary("getConversationStatsWithCache");

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
    if (!totals) {
        return null;
    }

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

export type { DailyStats, DateRange, SessionMetadataRecord, TokenUsage } from "@genesiscz/utils/claude/history-cache";
// Re-export cache functions for external use
export { getCachedTotals, getCacheStats, invalidateToday } from "@genesiscz/utils/claude/history-cache";
