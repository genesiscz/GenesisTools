/**
 * SQLite cache manager for Claude History statistics
 * Caches aggregated stats to avoid re-scanning all JSONL files on every request
 */

import { Database } from "bun:sqlite";
import logger from "@app/logger";
import { existsSync, mkdirSync } from "fs";
import { stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_CACHE_DIR = join(homedir(), ".genesis-tools", "claude-history");
const DB_NAME = "stats-cache.db";

let _db: Database | null = null;

// =============================================================================
// Database Connection
// =============================================================================

export function getDatabase(cacheDir: string = DEFAULT_CACHE_DIR): Database {
    if (_db) {
        return _db;
    }

    // Ensure directory exists
    if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
    }

    const dbPath = join(cacheDir, DB_NAME);
    logger.debug(`Opening stats cache database at ${dbPath}`);

    _db = new Database(dbPath);
    _db.exec("PRAGMA journal_mode = WAL");

    initSchema(_db);

    return _db;
}

export function closeDatabase(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

// =============================================================================
// Schema
// =============================================================================

function initSchema(db: Database): void {
    db.exec(`
    -- Daily aggregated statistics
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '__all__',
      conversations INTEGER NOT NULL DEFAULT 0,
      messages INTEGER NOT NULL DEFAULT 0,
      subagent_sessions INTEGER NOT NULL DEFAULT 0,
      tool_counts TEXT, -- JSON object: {"Read": 50, "Bash": 30}
      hourly_activity TEXT, -- JSON object: {"0": 5, "1": 2, ...}
      token_usage TEXT, -- JSON object: {"inputTokens": 1000, "outputTokens": 500, ...}
      model_counts TEXT, -- JSON object: {"opus": 50, "sonnet": 30, "haiku": 10}
      branch_counts TEXT, -- JSON object: {"main": 100, "feat/xyz": 50}
      computed_at TEXT NOT NULL,
      PRIMARY KEY (date, project)
    );

    -- File index for incremental updates
    CREATE TABLE IF NOT EXISTS file_index (
      file_path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_date TEXT,
      last_date TEXT,
      project TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      last_indexed TEXT NOT NULL
    );

    -- Cache metadata
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Quick totals cache (for instant loading)
    CREATE TABLE IF NOT EXISTS totals_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_conversations INTEGER NOT NULL DEFAULT 0,
      total_messages INTEGER NOT NULL DEFAULT 0,
      total_subagents INTEGER NOT NULL DEFAULT 0,
      project_count INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL
    );

    -- Session metadata cache (for claude-resume fast lookup)
    CREATE TABLE IF NOT EXISTS session_metadata (
      file_path TEXT PRIMARY KEY,
      session_id TEXT,
      custom_title TEXT,
      summary TEXT,
      first_prompt TEXT,
      git_branch TEXT,
      project TEXT,
      cwd TEXT,
      mtime INTEGER NOT NULL,
      first_timestamp TEXT,
      is_subagent INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date);
    CREATE INDEX IF NOT EXISTS idx_file_index_mtime ON file_index(mtime);
    CREATE INDEX IF NOT EXISTS idx_file_index_project ON file_index(project);
    CREATE INDEX IF NOT EXISTS idx_session_metadata_session_id ON session_metadata(session_id);
  `);

    // Migrations: Add columns that may be missing from older schemas
    const migrations = [
        "ALTER TABLE daily_stats ADD COLUMN token_usage TEXT",
        "ALTER TABLE daily_stats ADD COLUMN model_counts TEXT",
        "ALTER TABLE daily_stats ADD COLUMN branch_counts TEXT",
    ];

    for (const migration of migrations) {
        try {
            db.exec(migration);
        } catch {
            // Column already exists - ignore error
        }
    }
}

// =============================================================================
// Types
// =============================================================================

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
    modelCounts: Record<string, number>; // { "opus": 50, "sonnet": 30, "haiku": 10 }
    branchCounts: Record<string, number>; // { "main": 100, "feat/xyz": 50 }
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
    from?: string; // ISO date string (YYYY-MM-DD)
    to?: string; // ISO date string (YYYY-MM-DD)
}

// =============================================================================
// Quick Totals (for instant loading)
// =============================================================================

export function getCachedTotals(): CachedTotals | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM totals_cache WHERE id = 1").get() as {
        total_conversations: number;
        total_messages: number;
        total_subagents: number;
        project_count: number;
        last_updated: string;
    } | null;

    if (!row) return null;

    return {
        totalConversations: row.total_conversations,
        totalMessages: row.total_messages,
        totalSubagents: row.total_subagents,
        projectCount: row.project_count,
        lastUpdated: row.last_updated,
    };
}

export function updateCachedTotals(totals: Omit<CachedTotals, "lastUpdated">): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.query(`
    INSERT OR REPLACE INTO totals_cache (id, total_conversations, total_messages, total_subagents, project_count, last_updated)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(totals.totalConversations, totals.totalMessages, totals.totalSubagents, totals.projectCount, now);
}

// =============================================================================
// File Index Operations
// =============================================================================

export function getFileIndex(filePath: string): FileIndexRecord | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM file_index WHERE file_path = ?").get(filePath) as {
        file_path: string;
        mtime: number;
        message_count: number;
        first_date: string | null;
        last_date: string | null;
        project: string | null;
        is_subagent: number;
        last_indexed: string;
    } | null;

    if (!row) return null;

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

export function upsertFileIndex(record: FileIndexRecord): void {
    const db = getDatabase();
    db.query(`
    INSERT OR REPLACE INTO file_index (file_path, mtime, message_count, first_date, last_date, project, is_subagent, last_indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

export function getAllFileIndexes(): FileIndexRecord[] {
    const db = getDatabase();
    const rows = db.query("SELECT * FROM file_index").all() as Array<{
        file_path: string;
        mtime: number;
        message_count: number;
        first_date: string | null;
        last_date: string | null;
        project: string | null;
        is_subagent: number;
        last_indexed: string;
    }>;

    return rows.map((row) => ({
        filePath: row.file_path,
        mtime: row.mtime,
        messageCount: row.message_count,
        firstDate: row.first_date,
        lastDate: row.last_date,
        project: row.project,
        isSubagent: row.is_subagent === 1,
        lastIndexed: row.last_indexed,
    }));
}

export async function checkFileChanged(filePath: string): Promise<boolean> {
    const indexed = getFileIndex(filePath);
    if (!indexed) return true;

    try {
        const fileStat = await stat(filePath);
        return Math.floor(fileStat.mtimeMs) !== indexed.mtime;
    } catch {
        return true;
    }
}

export function removeFileIndex(filePath: string): void {
    const db = getDatabase();
    db.query("DELETE FROM file_index WHERE file_path = ?").run(filePath);
}

// =============================================================================
// Daily Stats Operations
// =============================================================================

const DEFAULT_TOKEN_USAGE: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
};

/**
 * Safely parse JSON with a fallback value if parsing fails
 */
function safeJsonParse<T>(input: string | null | undefined, fallback: T): T {
    if (input === null || input === undefined) return fallback;
    try {
        return JSON.parse(input) as T;
    } catch {
        logger.warn(`Failed to parse JSON from cache, using fallback. Input: ${input.slice(0, 100)}...`);
        return fallback;
    }
}

export function getDailyStats(date: string, project: string = "__all__"): DailyStats | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM daily_stats WHERE date = ? AND project = ?").get(date, project) as {
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
        computed_at: string;
    } | null;

    if (!row) return null;

    return {
        date: row.date,
        project: row.project,
        conversations: row.conversations,
        messages: row.messages,
        subagentSessions: row.subagent_sessions,
        toolCounts: safeJsonParse(row.tool_counts, {}),
        hourlyActivity: safeJsonParse(row.hourly_activity, {}),
        tokenUsage: safeJsonParse(row.token_usage, { ...DEFAULT_TOKEN_USAGE }),
        modelCounts: safeJsonParse(row.model_counts, {}),
        branchCounts: safeJsonParse(row.branch_counts, {}),
    };
}

export function upsertDailyStats(stats: DailyStats): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.query(`
    INSERT OR REPLACE INTO daily_stats (date, project, conversations, messages, subagent_sessions, tool_counts, hourly_activity, token_usage, model_counts, branch_counts, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        stats.date,
        stats.project,
        stats.conversations,
        stats.messages,
        stats.subagentSessions,
        JSON.stringify(stats.toolCounts),
        JSON.stringify(stats.hourlyActivity),
        JSON.stringify(stats.tokenUsage),
        JSON.stringify(stats.modelCounts),
        JSON.stringify(stats.branchCounts),
        now
    );
}

export function getDailyStatsInRange(range: DateRange): DailyStats[] {
    const db = getDatabase();

    let sql = "SELECT * FROM daily_stats WHERE project = '__all__'";
    const params: string[] = [];

    if (range.from) {
        sql += " AND date >= ?";
        params.push(range.from);
    }
    if (range.to) {
        sql += " AND date <= ?";
        params.push(range.to);
    }

    sql += " ORDER BY date DESC";

    const rows = db.query(sql).all(...params) as Array<{
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
        computed_at: string;
    }>;

    return rows.map((row) => ({
        date: row.date,
        project: row.project,
        conversations: row.conversations,
        messages: row.messages,
        subagentSessions: row.subagent_sessions,
        toolCounts: safeJsonParse(row.tool_counts, {}),
        hourlyActivity: safeJsonParse(row.hourly_activity, {}),
        tokenUsage: safeJsonParse(row.token_usage, { ...DEFAULT_TOKEN_USAGE }),
        modelCounts: safeJsonParse(row.model_counts, {}),
        branchCounts: safeJsonParse(row.branch_counts, {}),
    }));
}

export function getCachedDates(): string[] {
    const db = getDatabase();
    const rows = db
        .query("SELECT DISTINCT date FROM daily_stats WHERE project = '__all__' ORDER BY date DESC")
        .all() as Array<{
        date: string;
    }>;
    return rows.map((r) => r.date);
}

export function deleteDailyStats(date: string): void {
    const db = getDatabase();
    db.query("DELETE FROM daily_stats WHERE date = ?").run(date);
}

// =============================================================================
// Cache Meta Operations
// =============================================================================

export function getCacheMeta(key: string): string | null {
    const db = getDatabase();
    const row = db.query("SELECT value FROM cache_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
}

export function setCacheMeta(key: string, value: string): void {
    const db = getDatabase();
    db.query("INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)").run(key, value);
}

// =============================================================================
// Aggregation Helpers
// =============================================================================

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
    // For cumulative charts
    dailyTokens: Record<string, TokenUsage>;
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
        tokenUsage: { ...DEFAULT_TOKEN_USAGE },
        modelCounts: {},
        branchCounts: {},
        dailyTokens: {},
    };

    for (const day of dailyStats) {
        result.totalConversations += day.conversations;
        result.totalMessages += day.messages;
        result.subagentCount += day.subagentSessions;
        result.dailyActivity[day.date] = day.messages;

        // Merge tool counts
        for (const [tool, count] of Object.entries(day.toolCounts)) {
            result.toolCounts[tool] = (result.toolCounts[tool] || 0) + count;
        }

        // Merge hourly activity
        for (const [hour, count] of Object.entries(day.hourlyActivity)) {
            result.hourlyActivity[hour] = (result.hourlyActivity[hour] || 0) + count;
        }

        // Merge token usage
        if (day.tokenUsage) {
            result.tokenUsage.inputTokens += day.tokenUsage.inputTokens || 0;
            result.tokenUsage.outputTokens += day.tokenUsage.outputTokens || 0;
            result.tokenUsage.cacheCreateTokens += day.tokenUsage.cacheCreateTokens || 0;
            result.tokenUsage.cacheReadTokens += day.tokenUsage.cacheReadTokens || 0;
            result.dailyTokens[day.date] = { ...day.tokenUsage };
        }

        // Merge model counts
        for (const [model, count] of Object.entries(day.modelCounts || {})) {
            result.modelCounts[model] = (result.modelCounts[model] || 0) + count;
        }

        // Merge branch counts
        for (const [branch, count] of Object.entries(day.branchCounts || {})) {
            result.branchCounts[branch] = (result.branchCounts[branch] || 0) + count;
        }
    }

    return result;
}

// =============================================================================
// Cache Invalidation
// =============================================================================

export function invalidateToday(): void {
    const today = new Date().toISOString().split("T")[0];
    deleteDailyStats(today);
    logger.debug(`Invalidated cache for today: ${today}`);
}

export function invalidateDate(date: string): void {
    deleteDailyStats(date);
    logger.debug(`Invalidated cache for date: ${date}`);
}

export function invalidateDateRange(fromDate: string | null, toDate: string | null): void {
    if (!fromDate || !toDate) return;

    const db = getDatabase();
    db.query("DELETE FROM daily_stats WHERE date >= ? AND date <= ?").run(fromDate, toDate);
    logger.debug(`Invalidated cache for date range: ${fromDate} to ${toDate}`);
}

export function clearAllCache(): void {
    const db = getDatabase();
    db.exec(`
    DELETE FROM daily_stats;
    DELETE FROM file_index;
    DELETE FROM cache_meta;
    DELETE FROM totals_cache;
  `);
    logger.info("Cleared all stats cache");
}

// =============================================================================
// Cache Statistics
// =============================================================================

export function getCacheStats(): {
    totalDays: number;
    totalFiles: number;
    oldestDate: string | null;
    newestDate: string | null;
    lastUpdated: string | null;
} {
    const db = getDatabase();

    const daysCount = (
        db.query("SELECT COUNT(DISTINCT date) as count FROM daily_stats WHERE project = '__all__'").get() as {
            count: number;
        }
    ).count;
    const filesCount = (db.query("SELECT COUNT(*) as count FROM file_index").get() as { count: number }).count;
    const oldest = (
        db.query("SELECT MIN(date) as date FROM daily_stats WHERE project = '__all__'").get() as { date: string | null }
    )?.date;
    const newest = (
        db.query("SELECT MAX(date) as date FROM daily_stats WHERE project = '__all__'").get() as { date: string | null }
    )?.date;
    const lastUpdated = getCacheMeta("last_full_update");

    return {
        totalDays: daysCount,
        totalFiles: filesCount,
        oldestDate: oldest,
        newestDate: newest,
        lastUpdated,
    };
}

// =============================================================================
// Session Metadata Operations
// =============================================================================

export function getSessionMetadata(filePath: string): SessionMetadataRecord | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM session_metadata WHERE file_path = ?").get(filePath) as {
        file_path: string;
        session_id: string | null;
        custom_title: string | null;
        summary: string | null;
        first_prompt: string | null;
        git_branch: string | null;
        project: string | null;
        cwd: string | null;
        mtime: number;
        first_timestamp: string | null;
        is_subagent: number;
    } | null;

    if (!row) return null;

    return {
        filePath: row.file_path,
        sessionId: row.session_id,
        customTitle: row.custom_title,
        summary: row.summary,
        firstPrompt: row.first_prompt,
        gitBranch: row.git_branch,
        project: row.project,
        cwd: row.cwd,
        mtime: row.mtime,
        firstTimestamp: row.first_timestamp,
        isSubagent: row.is_subagent === 1,
    };
}

export function upsertSessionMetadata(record: SessionMetadataRecord): void {
    const db = getDatabase();
    db.query(`
    INSERT OR REPLACE INTO session_metadata
      (file_path, session_id, custom_title, summary, first_prompt, git_branch, project, cwd, mtime, first_timestamp, is_subagent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        record.filePath,
        record.sessionId,
        record.customTitle,
        record.summary,
        record.firstPrompt,
        record.gitBranch,
        record.project,
        record.cwd,
        record.mtime,
        record.firstTimestamp,
        record.isSubagent ? 1 : 0
    );
}

export function getAllSessionMetadata(): SessionMetadataRecord[] {
    const db = getDatabase();
    const rows = db.query("SELECT * FROM session_metadata ORDER BY first_timestamp DESC").all() as Array<{
        file_path: string;
        session_id: string | null;
        custom_title: string | null;
        summary: string | null;
        first_prompt: string | null;
        git_branch: string | null;
        project: string | null;
        cwd: string | null;
        mtime: number;
        first_timestamp: string | null;
        is_subagent: number;
    }>;

    return rows.map((row) => ({
        filePath: row.file_path,
        sessionId: row.session_id,
        customTitle: row.custom_title,
        summary: row.summary,
        firstPrompt: row.first_prompt,
        gitBranch: row.git_branch,
        project: row.project,
        cwd: row.cwd,
        mtime: row.mtime,
        firstTimestamp: row.first_timestamp,
        isSubagent: row.is_subagent === 1,
    }));
}

export function getSessionMetadataByDir(dirPath: string): SessionMetadataRecord[] {
    const db = getDatabase();
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    const rows = db
        .query("SELECT * FROM session_metadata WHERE file_path LIKE ? ORDER BY first_timestamp DESC")
        .all(`${prefix}%`) as Array<{
        file_path: string;
        session_id: string | null;
        custom_title: string | null;
        summary: string | null;
        first_prompt: string | null;
        git_branch: string | null;
        project: string | null;
        cwd: string | null;
        mtime: number;
        first_timestamp: string | null;
        is_subagent: number;
    }>;

    return rows.map((row) => ({
        filePath: row.file_path,
        sessionId: row.session_id,
        customTitle: row.custom_title,
        summary: row.summary,
        firstPrompt: row.first_prompt,
        gitBranch: row.git_branch,
        project: row.project,
        cwd: row.cwd,
        mtime: row.mtime,
        firstTimestamp: row.first_timestamp,
        isSubagent: row.is_subagent === 1,
    }));
}

export function getSessionMetadataByProject(project: string): SessionMetadataRecord[] {
    const db = getDatabase();
    const rows = db
        .query("SELECT * FROM session_metadata WHERE project = ? ORDER BY first_timestamp DESC")
        .all(project) as Array<{
        file_path: string;
        session_id: string | null;
        custom_title: string | null;
        summary: string | null;
        first_prompt: string | null;
        git_branch: string | null;
        project: string | null;
        cwd: string | null;
        mtime: number;
        first_timestamp: string | null;
        is_subagent: number;
    }>;

    return rows.map((row) => ({
        filePath: row.file_path,
        sessionId: row.session_id,
        customTitle: row.custom_title,
        summary: row.summary,
        firstPrompt: row.first_prompt,
        gitBranch: row.git_branch,
        project: row.project,
        cwd: row.cwd,
        mtime: row.mtime,
        firstTimestamp: row.first_timestamp,
        isSubagent: row.is_subagent === 1,
    }));
}
