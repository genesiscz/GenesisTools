/**
 * Provider-scoped compatibility facade for Claude history cache consumers.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { HistoryCacheRepository } from "@genesiscz/utils/agent-sessions/cache-repository";
import type {
    CachedTotals,
    CacheStats,
    DailyStats,
    DateRange,
    FileIndexRecord,
    SessionMetadataRecord,
} from "@genesiscz/utils/agent-sessions/cache-types";
import { HistoryDatabase } from "@genesiscz/utils/agent-sessions/database";
import { initializeCompactHistorySchema } from "@genesiscz/utils/agent-sessions/migrations";
import { logger } from "@genesiscz/utils/logger";

export { aggregateDailyStats } from "@genesiscz/utils/agent-sessions/cache-repository";
export type {
    AggregatedStats,
    CachedTotals,
    CacheStats,
    DailyStats,
    DateRange,
    FileIndexRecord,
    SessionMetadataRecord,
    TokenUsage,
} from "@genesiscz/utils/agent-sessions/cache-types";

const DB_NAME = "index.db";
const CLAUDE_PROVIDER_ID = "anthropic-sub";
const initialized = new WeakSet<Database>();

export function getDatabase(cacheDir?: string): Database {
    const db = HistoryDatabase.getInstance(cacheDir === undefined ? undefined : join(cacheDir, DB_NAME)).getDb();
    if (!initialized.has(db)) {
        initializeCompactHistorySchema(db);
        initialized.add(db);
    }
    return db;
}

function cache(): HistoryCacheRepository {
    return new HistoryCacheRepository(getDatabase(), CLAUDE_PROVIDER_ID);
}

export function closeDatabase(): void {
    HistoryDatabase.closeInstance();
}

export function getCachedTotals(): CachedTotals | null {
    return cache().getCachedTotals();
}

export function updateCachedTotals(totals: Omit<CachedTotals, "lastUpdated">): void {
    cache().updateCachedTotals(totals);
}

export function getFileIndex(filePath: string): FileIndexRecord | null {
    return cache().getFileIndex(filePath);
}

export function upsertFileIndex(record: FileIndexRecord): void {
    cache().upsertFileIndex(record);
}

export function getAllFileIndexes(): FileIndexRecord[] {
    return cache().getAllFileIndexes();
}

export function getFileIndexProjectCounts(range?: DateRange): Record<string, number> {
    return cache().getFileIndexProjectCounts(range);
}

export function getFileIndexConversationLengths(): number[] {
    return cache().getFileIndexConversationLengths();
}

export async function checkFileChanged(filePath: string): Promise<boolean> {
    return cache().checkFileChanged(filePath);
}

export function removeFileIndex(filePath: string): void {
    cache().removeFileIndex(filePath);
}

export function getDailyStats(date: string, project = "__all__"): DailyStats | null {
    return cache().getDailyStats(date, project);
}

export function upsertDailyStats(stats: DailyStats): void {
    cache().upsertDailyStats(stats);
}

export function getDailyStatsInRange(range: DateRange): DailyStats[] {
    return cache().getDailyStatsInRange(range);
}

export function getCachedDates(): string[] {
    return cache().getCachedDates();
}

export function deleteDailyStats(date: string): void {
    cache().deleteDailyStats(date);
}

export function getCacheMeta(key: string): string | null {
    return cache().getCacheMeta(key);
}

export function setCacheMeta(key: string, value: string): void {
    cache().setCacheMeta(key, value);
}

export function invalidateToday(): void {
    const today = new Date().toISOString().split("T")[0]!;
    cache().deleteDailyStats(today);
    logger.debug(`Invalidated cache for today: ${today}`);
}

export function invalidateDate(date: string): void {
    cache().deleteDailyStats(date);
    logger.debug(`Invalidated cache for date: ${date}`);
}

export function invalidateDateRange(fromDate: string | null, toDate: string | null): void {
    cache().invalidateDateRange(fromDate, toDate);
    if (fromDate && toDate) {
        logger.debug(`Invalidated cache for date range: ${fromDate} to ${toDate}`);
    }
}

export function clearAllCache(): void {
    cache().clearAllCache();
    logger.info("Cleared Claude stats cache");
}

export function getCacheStats(): CacheStats {
    return cache().getCacheStats();
}

export function getSessionMetadata(filePath: string): SessionMetadataRecord | null {
    return cache().getSessionMetadata(filePath);
}

export function getSessionMetadataBySessionId(sessionId: string): SessionMetadataRecord | null {
    return cache().getSessionMetadataBySessionId(sessionId);
}

export function upsertSessionMetadata(record: SessionMetadataRecord): void {
    cache().upsertSessionMetadata(record);
}

export function getAllSessionMetadata(): SessionMetadataRecord[] {
    return cache().getAllSessionMetadata();
}

export function getSessionMetadataByDir(dirPath: string): SessionMetadataRecord[] {
    return cache().getSessionMetadataByDir(dirPath);
}

export function getSessionMetadataByProject(project: string): SessionMetadataRecord[] {
    return cache().getSessionMetadataByProject(project);
}

export function resetDatabase(): void {
    cache().resetDatabase();
}

export function clearSessionMetadata(): void {
    cache().clearSessionMetadata();
}

export function getAllSessionMetadataFilePaths(): string[] {
    return cache().getAllSessionMetadataFilePaths();
}

export function removeSessionMetadataBatch(filePaths: string[]): void {
    cache().removeSessionMetadataBatch(filePaths);
}
