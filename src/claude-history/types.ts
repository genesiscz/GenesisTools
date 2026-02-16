/**
 * Claude Code Conversation History Types
 *
 * Core message types are shared at src/utils/claude/types.ts.
 * This file re-exports those + adds search-specific types.
 */

// Re-export all shared types for backward compatibility
export * from "../utils/claude/types";

// =============================================================================
// Search & Filter Types (specific to claude-history tool)
// =============================================================================

import type { ConversationMessage } from "../utils/claude/types";

export interface SearchFilters {
    query?: string;
    exact?: boolean;
    regex?: boolean;
    file?: string;
    tool?: string;
    project?: string;
    since?: Date;
    until?: Date;
    agentsOnly?: boolean;
    excludeAgents?: boolean;
    excludeThinking?: boolean;
    limit?: number;
    context?: number;
    summaryOnly?: boolean;
    excludeCurrentSession?: string;
    conversationDate?: Date;
    conversationDateUntil?: Date;
    commitHash?: string;
    commitMessage?: string;
    sortByRelevance?: boolean;
    /** Progress callback: (processed, total, currentFile) */
    onProgress?: (processed: number, total: number, currentFile: string) => void;
}

export interface SearchResult {
    filePath: string;
    project: string;
    sessionId: string;
    timestamp: Date;
    summary?: string;
    customTitle?: string;
    gitBranch?: string;
    matchedMessages: ConversationMessage[];
    contextMessages?: ConversationMessage[];
    isSubagent: boolean;
    relevanceScore?: number;
    commitHashes?: string[];
    userMessageCount?: number;
    assistantMessageCount?: number;
}

export interface ConversationMetadata {
    filePath: string;
    project: string;
    sessionId: string;
    firstTimestamp?: Date;
    lastTimestamp?: Date;
    summary?: string;
    customTitle?: string;
    gitBranch?: string;
    messageCount: number;
    isSubagent: boolean;
}
