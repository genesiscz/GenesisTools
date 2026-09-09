import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { openHistoryService } from "@genesiscz/utils/agent-sessions/open-service";
import type { HistorySearchResult } from "@genesiscz/utils/agent-sessions/service";
import type { NativeSourceIssue } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { ConversationMessage, SearchFilters, SearchResult } from "./types";

export function toClaudeSearchResult(result: HistorySearchResult, filters: SearchFilters): SearchResult {
    const metadata = result.metadata;
    return {
        filePath: metadata.filePath,
        project: metadata.project ?? "",
        sessionId: metadata.sessionId ?? basename(metadata.filePath, ".jsonl"),
        timestamp: result.timestamp,
        summary: metadata.summary ?? undefined,
        customTitle: metadata.customTitle ?? undefined,
        gitBranch: metadata.gitBranch ?? undefined,
        isSubagent: metadata.isSubagent,
        relevanceScore: result.relevanceScore,
        matchedMessages: result.matchedRecords.map(
            (record) => SafeJSON.parse(record.original, { strict: true }) as ConversationMessage
        ),
        ...(filters.context && result.contextRecords.length
            ? {
                  contextMessages: result.contextRecords.map(
                      (record) => SafeJSON.parse(record.original, { strict: true }) as ConversationMessage
                  ),
              }
            : {}),
        ...(filters.commitHash || filters.commitMessage
            ? { commitHashes: [...new Set(result.matchedEntries.flatMap((entry) => entry.commits))] }
            : {}),
    };
}

/** Claude DTO compatibility stays outside the provider-independent query engine. */
/**
 * The Claude twin of the cap on the shared adapter: a systemic problem produces one issue per
 * source, and 12,000 of them went to stderr and to the day log on every single search.
 */
function issueSample(issues: NativeSourceIssue[]) {
    return { total: issues.length, issues: issues.slice(0, 20) };
}

export async function searchIndexedClaudeHistory(options: {
    filters: SearchFilters;
    roots?: string[];
    database?: Database;
}): Promise<SearchResult[]> {
    const { filters } = options;
    const service = openHistoryService({ provider: "claude", roots: options.roots, database: options.database });
    const response = await service.search({
        ...filters,
        project: filters.project === "all" ? undefined : filters.project,
        limit: filters.limit === 0 && filters.summaryOnly ? undefined : filters.limit,
        excludeSessions: filters.excludeCurrentSession ? [filters.excludeCurrentSession] : undefined,
    });

    if (response.issues.length) {
        logger.warn(issueSample(response.issues), "Claude history source issues");
    }

    return response.results.map((result) => toClaudeSearchResult(result, filters));
}

export async function getIndexedClaudeConversation(options: {
    sessionId: string;
    roots?: string[];
    database?: Database;
}): Promise<SearchResult | null> {
    const service = openHistoryService({ provider: "claude", roots: options.roots, database: options.database });
    const response = await service.detail(options.sessionId);

    if (response.issues.length) {
        logger.warn(issueSample(response.issues), "Claude history detail source issues");
    }

    const result = response.results[0];
    return result ? toClaudeSearchResult(result, {}) : null;
}
