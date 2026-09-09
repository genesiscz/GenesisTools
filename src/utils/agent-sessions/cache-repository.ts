import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type {
    AggregatedStats,
    CachedTotals,
    CacheStats,
    DailyStats,
    DateRange,
    FileIndexRecord,
    SessionMetadataRecord,
} from "./cache-types";
import { zeroTokenUsage } from "./cache-types";
import { unresolvedHistorySourceKey } from "./identity";
import { type CachedHistoryMetadata, HistoryRepository } from "./repository";

const LEGACY_CACHE_META_KEYS = ["metadata_version", "last_full_update"] as const;

interface FileIndexRow {
    file_path: string;
    mtime: number;
    message_count: number;
    first_date: string | null;
    last_date: string | null;
    project: string | null;
    is_subagent: number;
    last_indexed: string;
}

interface DailyStatsRow {
    date: string;
    project: string;
    conversations: number;
    messages: number;
    subagent_sessions: number;
    tool_counts: string | null;
    hourly_activity: string | null;
    token_usage: string | null;
    model_counts: string | null;
    branch_counts: string | null;
}

function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
    if (input === null || input === undefined) {
        return fallback;
    }
    try {
        return SafeJSON.parse(input) as T;
    } catch {
        logger.warn({ preview: input.slice(0, 100) }, "Failed to parse cached history JSON; using fallback");
        return fallback;
    }
}

function decodeDailyStats(row: DailyStatsRow): DailyStats {
    return {
        date: row.date,
        project: row.project,
        conversations: row.conversations,
        messages: row.messages,
        subagentSessions: row.subagent_sessions,
        toolCounts: safeJsonParse(row.tool_counts, {}),
        hourlyActivity: safeJsonParse(row.hourly_activity, {}),
        tokenUsage: safeJsonParse(row.token_usage, { ...zeroTokenUsage() }),
        modelCounts: safeJsonParse(row.model_counts, {}),
        branchCounts: safeJsonParse(row.branch_counts, {}),
    };
}

function decodeFileIndex(row: FileIndexRow): FileIndexRecord {
    return {
        filePath: row.file_path,
        mtime: row.mtime,
        messageCount: row.message_count,
        firstDate: row.first_date,
        lastDate: row.last_date,
        project: row.project,
        isSubagent: row.is_subagent === 1,
        lastIndexed: row.last_indexed,
    };
}

export function toSessionMetadataRecord(metadata: CachedHistoryMetadata): SessionMetadataRecord {
    return {
        filePath: metadata.filePath,
        sessionId: metadata.sessionId,
        customTitle: metadata.customTitle,
        summary: metadata.summary,
        firstPrompt: metadata.firstPrompt,
        gitBranch: metadata.gitBranch,
        project: metadata.project,
        cwd: metadata.cwd,
        mtime: metadata.mtime,
        firstTimestamp: metadata.firstTimestamp,
        isSubagent: metadata.isSubagent,
        allUserText: metadata.allUserText,
    };
}

/** Provider-scoped SQL over the shared compact history schema. */
export class HistoryCacheRepository {
    private readonly metadata: HistoryRepository;

    constructor(
        private readonly db: Database,
        readonly providerId: string
    ) {
        this.metadata = new HistoryRepository(db);
    }

    getCachedTotals(): CachedTotals | null {
        const row = this.db
            .query<
                {
                    total_conversations: number;
                    total_messages: number;
                    total_subagents: number;
                    project_count: number;
                    last_updated: string;
                },
                [string, string]
            >(`
                SELECT total_conversations, total_messages, total_subagents, project_count, last_updated
                FROM totals_cache WHERE provider = ? AND scope = ?
            `)
            .get(this.providerId, "__all__");
        return row
            ? {
                  totalConversations: row.total_conversations,
                  totalMessages: row.total_messages,
                  totalSubagents: row.total_subagents,
                  projectCount: row.project_count,
                  lastUpdated: row.last_updated,
              }
            : null;
    }

    updateCachedTotals(totals: Omit<CachedTotals, "lastUpdated">): void {
        const now = new Date().toISOString();
        this.db
            .query(`
                INSERT INTO totals_cache (
                    provider, scope, id, total_conversations, total_messages,
                    total_subagents, project_count, last_updated
                ) VALUES (?, '__all__', 1, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, scope) DO UPDATE SET
                    id = 1,
                    total_conversations = excluded.total_conversations,
                    total_messages = excluded.total_messages,
                    total_subagents = excluded.total_subagents,
                    project_count = excluded.project_count,
                    last_updated = excluded.last_updated
            `)
            .run(
                this.providerId,
                totals.totalConversations,
                totals.totalMessages,
                totals.totalSubagents,
                totals.projectCount,
                now
            );
    }

    /**
     * Rows are written from discovery, which resolves symlinks, so a caller holding a raw path
     * has to match that or its row reads as "not indexed" — which looks exactly like an empty
     * cache. One normalisation here rather than one per caller: `src/claude/lib/history/search.ts`
     * remembered to realpath, the dashboard serializer did not.
     */
    private canonical(filePath: string): string {
        try {
            return realpathSync(filePath);
        } catch {
            return filePath;
        }
    }

    private sourceKeyForFile(rawPath: string): string {
        const filePath = this.canonical(rawPath);
        const indexed = this.db
            .query<{ source_key: string }, [string, string]>(
                "SELECT source_key FROM file_index WHERE provider = ? AND file_path = ? LIMIT 1"
            )
            .get(this.providerId, filePath);
        if (indexed) {
            return indexed.source_key;
        }
        return (
            this.metadata.getMetadataByFilePath({ providerId: this.providerId, filePath })?.sourceKey ??
            unresolvedHistorySourceKey({ providerId: this.providerId, filePath })
        );
    }

    getFileIndex(rawPath: string): FileIndexRecord | null {
        const filePath = this.canonical(rawPath);
        const row = this.db
            .query<FileIndexRow, [string, string]>(`
                SELECT file_path, mtime, message_count, first_date, last_date,
                    project, is_subagent, last_indexed
                FROM file_index
                WHERE provider = ? AND file_path = ? AND statistics_status != 'unavailable'
                LIMIT 1
            `)
            .get(this.providerId, filePath);
        return row ? decodeFileIndex(row) : null;
    }

    upsertFileIndex(record: FileIndexRecord): void {
        const sourceKey = this.sourceKeyForFile(record.filePath);
        this.db
            .query(`
                INSERT INTO file_index (
                    source_key, provider, file_path, mtime, message_count,
                    first_date, last_date, project, is_subagent, last_indexed,
                    statistics_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')
                ON CONFLICT(source_key) DO UPDATE SET
                    file_path = excluded.file_path,
                    mtime = excluded.mtime,
                    message_count = excluded.message_count,
                    first_date = excluded.first_date,
                    last_date = excluded.last_date,
                    project = excluded.project,
                    is_subagent = excluded.is_subagent,
                    last_indexed = excluded.last_indexed,
                    statistics_status = 'legacy'
            `)
            .run(
                sourceKey,
                this.providerId,
                record.filePath,
                record.mtime,
                record.messageCount,
                record.firstDate,
                record.lastDate,
                record.project,
                record.isSubagent ? 1 : 0,
                record.lastIndexed
            );
    }

    getAllFileIndexes(): FileIndexRecord[] {
        return this.db
            .query<FileIndexRow, [string]>(`
                SELECT file_path, mtime, message_count, first_date, last_date,
                    project, is_subagent, last_indexed
                FROM file_index
                WHERE provider = ? AND statistics_status != 'unavailable'
                ORDER BY file_path
            `)
            .all(this.providerId)
            .map(decodeFileIndex);
    }

    getFileIndexProjectCounts(range?: DateRange): Record<string, number> {
        const clauses = ["provider = ?", "statistics_status != 'unavailable'", "project IS NOT NULL"];
        const params = [this.providerId];
        if (range !== undefined) {
            // A session with no timestamped record has both dates NULL, and `NOT (NULL < ? OR ...)`
            // is NULL, so SQLite already dropped it. Say so instead of leaning on three-valued
            // logic: a dated range cannot honestly claim an undated session. 520 of 13,996 indexed
            // rows here are in that state, and none has only one of the two dates set.
            clauses.push("first_date IS NOT NULL AND last_date IS NOT NULL");
            clauses.push("NOT (last_date < ? OR first_date > ?)");
            params.push(range.from ?? "1970-01-01", range.to ?? "9999-12-31");
        }

        const rows = this.db
            .query(
                `SELECT project, COUNT(*) AS count
                 FROM file_index
                 WHERE ${clauses.join(" AND ")}
                 GROUP BY project
                 ORDER BY count DESC`
            )
            .all(...params) as Array<{ project: string; count: number }>;
        const counts: Record<string, number> = {};
        for (const row of rows) {
            counts[row.project] = row.count;
        }

        return counts;
    }

    getFileIndexConversationLengths(): number[] {
        return this.db
            .query<{ message_count: number }, [string]>(
                `SELECT message_count
                 FROM file_index
                 WHERE provider = ?
                   AND statistics_status != 'unavailable'
                   AND message_count > 0
                 ORDER BY message_count`
            )
            .all(this.providerId)
            .map((row) => row.message_count);
    }

    async checkFileChanged(filePath: string): Promise<boolean> {
        const indexed = this.getFileIndex(filePath);
        if (!indexed) {
            return true;
        }
        try {
            const fileStat = await stat(filePath);
            return Math.floor(fileStat.mtimeMs) !== indexed.mtime;
        } catch {
            return true;
        }
    }

    removeFileIndex(rawPath: string): void {
        this.db
            .query("DELETE FROM file_index WHERE provider = ? AND file_path = ?")
            .run(this.providerId, this.canonical(rawPath));
    }

    getDailyStats(date: string, project = "__all__"): DailyStats | null {
        const row = this.db
            .query<DailyStatsRow, [string, string, string]>(
                "SELECT * FROM daily_stats WHERE provider = ? AND date = ? AND project = ?"
            )
            .get(this.providerId, date, project);
        return row ? decodeDailyStats(row) : null;
    }

    upsertDailyStats(stats: DailyStats): void {
        const now = new Date().toISOString();
        this.db
            .query(`
                INSERT INTO daily_stats (
                    provider, date, project, conversations, messages, subagent_sessions,
                    tool_counts, hourly_activity, token_usage, model_counts, branch_counts,
                    computed_at, coverage
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')
                ON CONFLICT(provider, date, project) DO UPDATE SET
                    conversations = excluded.conversations,
                    messages = excluded.messages,
                    subagent_sessions = excluded.subagent_sessions,
                    tool_counts = excluded.tool_counts,
                    hourly_activity = excluded.hourly_activity,
                    token_usage = excluded.token_usage,
                    model_counts = excluded.model_counts,
                    branch_counts = excluded.branch_counts,
                    computed_at = excluded.computed_at,
                    coverage = 'legacy'
            `)
            .run(
                this.providerId,
                stats.date,
                stats.project,
                stats.conversations,
                stats.messages,
                stats.subagentSessions,
                SafeJSON.stringify(stats.toolCounts),
                SafeJSON.stringify(stats.hourlyActivity),
                SafeJSON.stringify(stats.tokenUsage),
                SafeJSON.stringify(stats.modelCounts),
                SafeJSON.stringify(stats.branchCounts),
                now
            );
    }

    getDailyStatsInRange(range: DateRange): DailyStats[] {
        const clauses = ["provider = ?", "project = '__all__'"];
        const params: string[] = [this.providerId];
        if (range.from) {
            clauses.push("date >= ?");
            params.push(range.from);
        }
        if (range.to) {
            clauses.push("date <= ?");
            params.push(range.to);
        }
        return (
            this.db
                .query(`SELECT * FROM daily_stats WHERE ${clauses.join(" AND ")} ORDER BY date DESC`)
                .all(...params) as DailyStatsRow[]
        ).map(decodeDailyStats);
    }

    getCachedDates(): string[] {
        return this.db
            .query<{ date: string }, [string]>(
                "SELECT DISTINCT date FROM daily_stats WHERE provider = ? AND project = '__all__' ORDER BY date DESC"
            )
            .all(this.providerId)
            .map((row) => row.date);
    }

    deleteDailyStats(date: string): void {
        this.db.query("DELETE FROM daily_stats WHERE provider = ? AND date = ?").run(this.providerId, date);
    }

    getCacheMeta(key: string): string | null {
        return (
            this.db.query<{ value: string }, [string]>("SELECT value FROM cache_meta WHERE key = ?").get(key)?.value ??
            null
        );
    }

    setCacheMeta(key: string, value: string): void {
        this.db
            .query(
                "INSERT INTO cache_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            )
            .run(key, value);
    }

    invalidateDateRange(fromDate: string | null, toDate: string | null): void {
        if (!fromDate || !toDate) {
            return;
        }
        this.db
            .query("DELETE FROM daily_stats WHERE provider = ? AND date >= ? AND date <= ?")
            .run(this.providerId, fromDate, toDate);
    }

    clearAllCache(): void {
        this.db.transaction(() => {
            this.db.query("DELETE FROM file_daily_stats WHERE provider = ?").run(this.providerId);
            this.db.query("DELETE FROM daily_stats WHERE provider = ?").run(this.providerId);
            this.db.query("DELETE FROM file_index WHERE provider = ?").run(this.providerId);
            this.db.query("DELETE FROM totals_cache WHERE provider = ?").run(this.providerId);
            this.db.query("DELETE FROM history_roots WHERE provider = ?").run(this.providerId);
            this.db.query("DELETE FROM history_source_issues WHERE provider = ?").run(this.providerId);
            // cache_meta is provider-free on purpose: these two keys are the pre-index Claude
            // compatibility markers that `getCacheMeta`/`setCacheMeta` read by their bare names,
            // and a provider column would break that contract for no gain. Every other provider's
            // only cache_meta row is its generation counter, which is monotonic and must survive
            // a clear — restarting it while another table still held higher-generation rows is
            // the hazard, not leaving it high.
            if (this.providerId === "anthropic-sub") {
                const statement = this.db.prepare("DELETE FROM cache_meta WHERE key = ?");
                for (const key of LEGACY_CACHE_META_KEYS) {
                    statement.run(key);
                }
            }
        })();
    }

    getCacheStats(): CacheStats {
        const days = this.db
            .query<{ count: number; oldest: string | null; newest: string | null }, [string]>(`
                SELECT COUNT(DISTINCT date) AS count, MIN(date) AS oldest, MAX(date) AS newest
                FROM daily_stats WHERE provider = ? AND project = '__all__'
            `)
            .get(this.providerId)!;
        const files = this.db
            .query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM file_index WHERE provider = ? AND statistics_status != 'unavailable'"
            )
            .get(this.providerId)!;
        return {
            totalDays: days.count,
            totalFiles: files.count,
            oldestDate: days.oldest,
            newestDate: days.newest,
            lastUpdated: this.getCacheMeta("last_full_update"),
        };
    }

    getSessionMetadata(rawPath: string): SessionMetadataRecord | null {
        const value = this.metadata.getMetadataByFilePath({
            providerId: this.providerId,
            filePath: this.canonical(rawPath),
        });
        return value ? toSessionMetadataRecord(value) : null;
    }

    getSessionMetadataBySessionId(sessionId: string): SessionMetadataRecord | null {
        const value = this.metadata.getMetadataBySessionId({ providerId: this.providerId, sessionId });
        return value ? toSessionMetadataRecord(value) : null;
    }

    upsertSessionMetadata(record: SessionMetadataRecord): void {
        this.metadata.upsertLegacyMetadata({ providerId: this.providerId, record });
    }

    getAllSessionMetadata(): SessionMetadataRecord[] {
        return this.metadata
            .listMetadata({ providerId: this.providerId, orderBy: "firstTimestamp" })
            .map(toSessionMetadataRecord);
    }

    getSessionMetadataByDir(rawPath: string): SessionMetadataRecord[] {
        return this.metadata
            .getMetadataByDir({ providerId: this.providerId, dirPath: this.canonical(rawPath) })
            .map(toSessionMetadataRecord);
    }

    getSessionMetadataByProject(project: string): SessionMetadataRecord[] {
        return this.metadata
            .getMetadataByProject({ providerId: this.providerId, project })
            .map(toSessionMetadataRecord);
    }

    clearSessionMetadata(): void {
        this.metadata.clearMetadata(this.providerId);
    }

    getAllSessionMetadataFilePaths(): string[] {
        return this.metadata.listMetadataFilePaths(this.providerId);
    }

    removeSessionMetadataBatch(filePaths: string[]): void {
        this.metadata.removeMetadataBatch({ providerId: this.providerId, filePaths });
    }

    resetDatabase(): void {
        this.db.transaction(() => {
            this.clearAllCache();
            this.clearSessionMetadata();
        })();
    }
}

export function aggregateDailyStats(dailyStats: DailyStats[]): AggregatedStats {
    const result: AggregatedStats = {
        totalConversations: 0,
        totalMessages: 0,
        subagentCount: 0,
        projectCounts: {},
        toolCounts: {},
        dailyActivity: {},
        hourlyActivity: {},
        tokenUsage: { ...zeroTokenUsage() },
        modelCounts: {},
        branchCounts: {},
        dailyTokens: {},
    };

    for (const day of dailyStats) {
        result.totalConversations += day.conversations;
        result.totalMessages += day.messages;
        result.subagentCount += day.subagentSessions;
        result.dailyActivity[day.date] = day.messages;

        for (const [tool, count] of Object.entries(day.toolCounts)) {
            result.toolCounts[tool] = (result.toolCounts[tool] || 0) + count;
        }

        for (const [hour, count] of Object.entries(day.hourlyActivity)) {
            result.hourlyActivity[hour] = (result.hourlyActivity[hour] || 0) + count;
        }

        if (day.tokenUsage) {
            result.tokenUsage.inputTokens += day.tokenUsage.inputTokens || 0;
            result.tokenUsage.outputTokens += day.tokenUsage.outputTokens || 0;
            result.tokenUsage.cacheCreateTokens += day.tokenUsage.cacheCreateTokens || 0;
            result.tokenUsage.cacheReadTokens += day.tokenUsage.cacheReadTokens || 0;
            result.dailyTokens[day.date] = { ...day.tokenUsage };
        }

        for (const [model, count] of Object.entries(day.modelCounts || {})) {
            result.modelCounts[model] = (result.modelCounts[model] || 0) + count;
        }

        for (const [branch, count] of Object.entries(day.branchCounts || {})) {
            result.branchCounts[branch] = (result.branchCounts[branch] || 0) + count;
        }
    }

    return result;
}
