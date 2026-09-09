export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
}

export interface DailyStats {
    date: string;
    project: string;
    conversations: number;
    messages: number;
    subagentSessions: number;
    toolCounts: Record<string, number>;
    hourlyActivity: Record<string, number>;
    tokenUsage: TokenUsage;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
}

export interface SessionMetadataRecord {
    filePath: string;
    sessionId: string | null;
    customTitle: string | null;
    summary: string | null;
    firstPrompt: string | null;
    gitBranch: string | null;
    project: string | null;
    cwd: string | null;
    mtime: number;
    firstTimestamp: string | null;
    isSubagent: boolean;
    allUserText: string | null;
}

export interface FileIndexRecord {
    filePath: string;
    mtime: number;
    messageCount: number;
    firstDate: string | null;
    lastDate: string | null;
    project: string | null;
    isSubagent: boolean;
    lastIndexed: string;
}

export interface CachedTotals {
    totalConversations: number;
    totalMessages: number;
    totalSubagents: number;
    projectCount: number;
    lastUpdated: string;
}

export interface DateRange {
    from?: string;
    to?: string;
}

export interface AggregatedStats {
    totalConversations: number;
    totalMessages: number;
    subagentCount: number;
    projectCounts: Record<string, number>;
    toolCounts: Record<string, number>;
    dailyActivity: Record<string, number>;
    hourlyActivity: Record<string, number>;
    tokenUsage: TokenUsage;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
    dailyTokens: Record<string, TokenUsage>;
}

export interface CacheStats {
    totalDays: number;
    totalFiles: number;
    oldestDate: string | null;
    newestDate: string | null;
    lastUpdated: string | null;
}

export interface HistoryFileStatistics {
    conversations: number;
    messages: number;
    subagentSessions: number;
    toolCounts: Record<string, number>;
    dailyActivity: Record<string, number>;
    hourlyActivity: Record<string, number>;
    tokenUsage: TokenUsage | null;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
    firstDate: string | null;
    lastDate: string | null;
}

/** The neutral element, defined once: four copies of it had drifted into three other files. */
export function zeroTokenUsage(): TokenUsage {
    return { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 };
}
