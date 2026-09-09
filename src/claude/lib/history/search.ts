/**
 * Claude Code Conversation History Library
 * Reusable functions for searching and parsing conversation history
 */

import { realpath, stat } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import { toSessionMetadataRecord } from "@genesiscz/utils/agent-sessions/cache-repository";
import { parseHistoryDate } from "@genesiscz/utils/agent-sessions/history-date";
import { openHistoryService } from "@genesiscz/utils/agent-sessions/open-service";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { claudeProjectName } from "@genesiscz/utils/agent-sessions/readers/claude-paths";
import { aggregateHistoryStatistics } from "@genesiscz/utils/agent-sessions/statistics-aggregate";
import type { NativeSessionReader, NativeSessionSource } from "@genesiscz/utils/agent-sessions/types";
import { concurrentMap } from "@genesiscz/utils/async";
import {
    aggregateDailyStats,
    type DateRange,
    getCachedTotals,
    getDailyStatsInRange,
    getFileIndex,
    getFileIndexConversationLengths,
    getFileIndexProjectCounts,
    type SessionMetadataRecord,
    setCacheMeta,
    type TokenUsage,
} from "@genesiscz/utils/claude/history-cache";
import { PROJECTS_DIR, resolveProjectDir } from "@genesiscz/utils/claude/projects";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { getIndexedClaudeConversation, searchIndexedClaudeHistory } from "./indexed-search";
import type { SearchFilters, SearchResult } from "./types";

// Re-export all types
export * from "./types";

const STATISTICS_READ_CONCURRENCY = 16;

function hist() {
    return profiler.scope("claude-history");
}

function profileAll(): boolean {
    return profiler.detail === "all";
}

export async function searchConversations(filters: SearchFilters): Promise<SearchResult[]> {
    return searchIndexedClaudeHistory({ filters });
}

// =============================================================================
// Get All Conversations (for listing)
// =============================================================================

export async function getAllConversations(filters: SearchFilters = {}): Promise<SearchResult[]> {
    const indexed = await searchIndexedClaudeHistory({ filters: { ...filters, summaryOnly: false } });
    return indexed.map((result) => ({
        ...result,
        userMessageCount: result.matchedMessages.filter((message) => message.type === "user").length,
        assistantMessageCount: result.matchedMessages.filter((message) => message.type === "assistant").length,
    }));
}

// =============================================================================
// Get Available Projects
// =============================================================================

export async function getAvailableProjects(): Promise<string[]> {
    const listing = await getSessionListing({ excludeSubagents: false });
    return [
        ...new Set(listing.sessions.map((session) => session.project).filter((value): value is string => !!value)),
    ].sort();
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
    const projectDir = options.project ? resolveProjectDir(options.project) : undefined;
    const scope = projectDir ? options.project || projectDir.split(sep).pop() || "unknown" : "all projects";
    const project = projectDir ? basename(projectDir) : undefined;
    const {
        metadata: all,
        report,
        reindexed,
    } = await p.measureAsync("listing.catalog", () =>
        openHistoryService({ provider: "claude" }).catalog({
            project,
            excludeAgents: !subagentsOnly && excludeSubagents,
            agentsOnly: subagentsOnly,
            limit,
        })
    );
    const subagentCount = all.filter((metadata) => metadata.isSubagent).length;
    const selected = subagentsOnly
        ? all.filter((metadata) => metadata.isSubagent)
        : excludeSubagents
          ? all.filter((metadata) => !metadata.isSubagent)
          : all;
    const sessions = selected.map(toSessionMetadataRecord);
    sessions.sort((left, right) => {
        const leftTime = left.firstTimestamp ? new Date(left.firstTimestamp).getTime() : 0;
        const rightTime = right.firstTimestamp ? new Date(right.firstTimestamp).getTime() : 0;
        return rightTime - leftTime;
    });
    const projects = new Set(all.map((metadata) => metadata.project).filter(Boolean));

    p.summary("getSessionListing");

    return {
        sessions: limit ? sessions.slice(0, limit) : sessions,
        total: all.length,
        subagents: subagentCount,
        indexed: report.parsed,
        staleRemoved: report.removed,
        reindexed,
        projectCount: projects.size,
        scope,
    };
}

// =============================================================================
// Get Conversation by Session ID
// =============================================================================

export async function getConversationBySessionId(sessionId: string): Promise<SearchResult | null> {
    return getIndexedClaudeConversation({ sessionId });
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

type ClaudeStatisticsReader = NativeSessionReader<string> & {
    kind: "claude";
    readStatistics: NonNullable<NativeSessionReader<string>["readStatistics"]>;
};

function isClaudeStatisticsReader(reader: NativeSessionReader<string>): reader is ClaudeStatisticsReader {
    return reader.kind === "claude" && reader.readStatistics !== undefined;
}

function claudeStatisticsReader(): ClaudeStatisticsReader {
    const { reader } = resolveHistoryProvider("claude");
    if (!isClaudeStatisticsReader(reader)) {
        throw new Error("Claude native history statistics are unavailable");
    }

    return reader;
}

function rootForClaudeFile(reader: NativeSessionReader<string>, filePath: string): string {
    const configured = reader
        .roots()
        .find((candidate) => filePath === candidate || filePath.startsWith(`${candidate}${sep}`));
    if (configured) {
        return configured;
    }

    let directory = dirname(filePath);
    while (dirname(directory) !== directory) {
        if (basename(directory).startsWith("-")) {
            return dirname(directory);
        }
        directory = dirname(directory);
    }

    return PROJECTS_DIR;
}

function sourceForClaudeFile(reader: NativeSessionReader<string>, filePath: string): NativeSessionSource<"claude"> {
    const root = rootForClaudeFile(reader, filePath);
    return {
        kind: "claude",
        root,
        sourceHome: dirname(root),
        filePath,
        dataPaths: [filePath],
        metadataPaths: [],
    };
}

export async function getConversationStats(): Promise<ConversationStats> {
    const p = hist();
    const reader = claudeStatisticsReader();
    const discovery = await p.measureAsync("stats-uncached.discover", () => reader.discover(reader.roots()));
    const issues = [...discovery.issues];
    const ordered = await p.measureAsync("stats-uncached.stat-sort", async () => {
        // One vanished file used to reject the whole call, and the burst was unbounded while the
        // read stage below is deliberately capped.
        const stated = await concurrentMap({
            items: discovery.sources,
            concurrency: STATISTICS_READ_CONCURRENCY,
            fn: async (source) => ({ source, mtime: (await stat(source.filePath)).mtimeMs }),
            onError: (source, error) => {
                issues.push({ path: source.filePath, message: `Could not stat source: ${String(error)}` });
            },
        });
        const sources = [...stated.values()];
        sources.sort((left, right) => right.mtime - left.mtime);
        return sources.map(({ source }) => source);
    });
    const bySource = await p.measureAsync("stats-uncached.read", () =>
        concurrentMap({
            items: ordered,
            concurrency: STATISTICS_READ_CONCURRENCY,
            fn: async (source) => {
                const statistics = await reader.readStatistics(source);
                issues.push(...statistics.issues);
                return statistics;
            },
            // Without this a failed read is dropped from the aggregate with no trace, so the
            // totals are quietly short and nothing says which source is missing.
            onError: (source, error) => {
                issues.push({ path: source.filePath, message: `Could not read statistics: ${String(error)}` });
            },
        })
    );
    const statistics = aggregateHistoryStatistics(
        ordered.flatMap((source) => {
            const value = bySource.get(source);
            return value ? [{ project: claudeProjectName({ source }) ?? "", statistics: value }] : [];
        })
    );

    if (issues.length > 0) {
        logger.warn({ issues }, "Claude uncached statistics skipped malformed or unavailable source records");
    }

    p.summary("getConversationStats");
    return statistics;
}

// =============================================================================
// Date Parsing Helper
// =============================================================================

export function parseDate(dateStr: string): Date {
    return parseHistoryDate({ value: dateStr });
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

/** @deprecated Use the provider statistics reader through HistoryService. */
export async function computeFileStats(filePath: string): Promise<FileStats> {
    const canonicalFilePath = await realpath(filePath);
    const reader = claudeStatisticsReader();
    const statistics = await reader.readStatistics(sourceForClaudeFile(reader, canonicalFilePath));
    return {
        ...statistics.summary,
        tokenUsage: statistics.summary.tokenUsage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
        },
    };
}

/** @deprecated Refresh provider statistics through HistoryService. */
export async function processFileForCache(filePath: string): Promise<FileStats | null> {
    const run = async (): Promise<FileStats | null> => {
        try {
            const canonicalFilePath = await realpath(filePath);
            const fileStat = await stat(canonicalFilePath);
            const mtime = Math.floor(fileStat.mtimeMs);
            const existing = getFileIndex(canonicalFilePath);
            if (existing?.mtime === mtime) {
                return null;
            }

            const source = sourceForClaudeFile(claudeStatisticsReader(), canonicalFilePath);
            await openHistoryService({ provider: "claude", roots: [source.root] }).refreshStatistics();
            const refreshed = getFileIndex(canonicalFilePath);
            return refreshed?.mtime === mtime ? computeFileStats(canonicalFilePath) : null;
        } catch (error) {
            logger.warn({ error, filePath }, "Claude statistics compatibility refresh failed");
            return null;
        }
    };

    return profileAll() ? hist().measureAsync("processFileForCache", run) : run();
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

    const refreshed = await p.measureAsync("stats.refresh", () =>
        openHistoryService({ provider: "claude" }).refreshStatistics({ force: forceRefresh, onProgress })
    );

    if (refreshed.issues.length) {
        logger.warn(
            { issues: refreshed.issues },
            "Claude statistics retain previous aggregates for incomplete sources"
        );
    }

    if (refreshed.coverage === "complete") {
        setCacheMeta("last_full_update", new Date().toISOString());
    }

    // Get all daily stats (or filtered by date range)
    const dailyStats = getDailyStatsInRange(dateRange || {});

    // Aggregate into final stats
    const aggregated = aggregateDailyStats(dailyStats);

    // Get project counts from file index
    const projectCounts = getFileIndexProjectCounts();

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
    return getFileIndexConversationLengths();
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
        const projectCounts = getFileIndexProjectCounts(range);

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
