import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import logger from "@app/logger";
import type { LanguageModelUsage } from "ai";

export interface UsageRecord {
    id?: number;
    sessionId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    cost: number;
    timestamp: string;
    messageIndex?: number;
}

export interface DailyUsage {
    date: string;
    totalCost: number;
    totalTokens: number;
    messageCount: number;
    providerCount: number;
}

export interface ProviderUsage {
    provider: string;
    totalCost: number;
    totalTokens: number;
    messageCount: number;
    avgCostPerMessage: number;
}

export interface ModelUsage {
    provider: string;
    model: string;
    totalCost: number;
    totalTokens: number;
    messageCount: number;
    avgCostPerMessage: number;
}

export class UsageDatabase {
    private db: Database;
    private dbPath: string;

    constructor(dbPath?: string) {
        // Default to ~/.genesis-tools/ask.sqlite
        const defaultPath = join(homedir(), ".genesis-tools", "ask.sqlite");
        this.dbPath = dbPath || defaultPath;

        // Ensure directory exists
        const dbDir = dirname(this.dbPath);
        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
            logger.info(`Created directory: ${dbDir}`);
        }

        // Open database
        this.db = new Database(this.dbPath);
        this.db.exec("PRAGMA journal_mode = WAL;"); // Better concurrency

        this.initializeSchema();
    }

    private initializeSchema(): void {
        // Usage records table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cached_input_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                cost REAL NOT NULL DEFAULT 0,
                timestamp TEXT NOT NULL,
                message_index INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Indexes for faster queries
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_session_id ON usage_records(session_id);
            CREATE INDEX IF NOT EXISTS idx_timestamp ON usage_records(timestamp);
            CREATE INDEX IF NOT EXISTS idx_provider_model ON usage_records(provider, model);
            CREATE INDEX IF NOT EXISTS idx_date ON usage_records(date(timestamp));
        `);

        logger.debug("Usage database schema initialized");
    }

    async recordUsage(
        sessionId: string,
        provider: string,
        model: string,
        usage: LanguageModelUsage,
        cost: number,
        messageIndex?: number,
    ): Promise<number> {
        // DEBUG: Log what we're storing
        logger.debug(`[UsageDatabase] recordUsage called for ${provider}/${model}`);
        logger.debug({ usage: JSON.stringify(usage, null, 2) }, `[UsageDatabase] usage object`);

        // Extract tokens using new API naming
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cachedInputTokens = usage.cachedInputTokens ?? 0;
        const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

        logger.debug(
            { inputTokens, outputTokens, cachedInputTokens, totalTokens, cost },
            `[UsageDatabase] Storing tokens`,
        );

        const timestamp = new Date().toISOString();

        const stmt = this.db.prepare(`
            INSERT INTO usage_records (
                session_id, provider, model,
                input_tokens, output_tokens, cached_input_tokens, total_tokens,
                cost, timestamp, message_index
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            sessionId,
            provider,
            model,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            totalTokens,
            cost,
            timestamp,
            messageIndex ?? null,
        );

        logger.debug(`[UsageDatabase] Record inserted with ID: ${result.lastInsertRowid}`);

        return result.lastInsertRowid as number;
    }

    getDailyUsage(days: number = 30): DailyUsage[] {
        const stmt = this.db.prepare(`
            SELECT 
                date(timestamp) as date,
                SUM(cost) as total_cost,
                SUM(total_tokens) as total_tokens,
                COUNT(*) as message_count,
                COUNT(DISTINCT provider) as provider_count
            FROM usage_records
            WHERE date(timestamp) >= date('now', '-' || ? || ' days')
            GROUP BY date(timestamp)
            ORDER BY date DESC
        `);

        const rows = stmt.all(days) as Array<{
            date: string;
            total_cost: number;
            total_tokens: number;
            message_count: number;
            provider_count: number;
        }>;

        return rows.map((row) => ({
            date: row.date,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            providerCount: row.provider_count,
        }));
    }

    getProviderUsage(days: number = 30): ProviderUsage[] {
        const stmt = this.db.prepare(`
            SELECT 
                provider,
                SUM(cost) as total_cost,
                SUM(total_tokens) as total_tokens,
                COUNT(*) as message_count,
                AVG(cost) as avg_cost_per_message
            FROM usage_records
            WHERE date(timestamp) >= date('now', '-' || ? || ' days')
            GROUP BY provider
            ORDER BY total_cost DESC
        `);

        const rows = stmt.all(days) as Array<{
            provider: string;
            total_cost: number;
            total_tokens: number;
            message_count: number;
            avg_cost_per_message: number;
        }>;

        return rows.map((row) => ({
            provider: row.provider,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            avgCostPerMessage: row.avg_cost_per_message,
        }));
    }

    getModelUsage(days: number = 30): ModelUsage[] {
        const stmt = this.db.prepare(`
            SELECT 
                provider,
                model,
                SUM(cost) as total_cost,
                SUM(total_tokens) as total_tokens,
                COUNT(*) as message_count,
                AVG(cost) as avg_cost_per_message
            FROM usage_records
            WHERE date(timestamp) >= date('now', '-' || ? || ' days')
            GROUP BY provider, model
            ORDER BY total_cost DESC
        `);

        const rows = stmt.all(days) as Array<{
            provider: string;
            model: string;
            total_cost: number;
            total_tokens: number;
            message_count: number;
            avg_cost_per_message: number;
        }>;

        return rows.map((row) => ({
            provider: row.provider,
            model: row.model,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            avgCostPerMessage: row.avg_cost_per_message,
        }));
    }

    getSessionUsage(sessionId: string): UsageRecord[] {
        const stmt = this.db.prepare(`
            SELECT 
                id, session_id, provider, model,
                input_tokens, output_tokens, cached_input_tokens, total_tokens,
                cost, timestamp, message_index
            FROM usage_records
            WHERE session_id = ?
            ORDER BY timestamp ASC
        `);

        const rows = stmt.all(sessionId) as Array<{
            id: number;
            session_id: string;
            provider: string;
            model: string;
            input_tokens: number;
            output_tokens: number;
            cached_input_tokens: number;
            total_tokens: number;
            cost: number;
            timestamp: string;
            message_index: number | null;
        }>;

        return rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            provider: row.provider,
            model: row.model,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cachedInputTokens: row.cached_input_tokens,
            totalTokens: row.total_tokens,
            cost: row.cost,
            timestamp: row.timestamp,
            messageIndex: row.message_index ?? undefined,
        }));
    }

    getTotalUsage(days?: number): {
        totalCost: number;
        totalTokens: number;
        messageCount: number;
        sessionCount: number;
    } {
        let stmt: Statement;
        if (days) {
            stmt = this.db.prepare(`
                SELECT
                    SUM(cost) as total_cost,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as message_count,
                    COUNT(DISTINCT session_id) as session_count
                FROM usage_records
                WHERE date(timestamp) >= date('now', '-' || ? || ' days')
            `);
        } else {
            stmt = this.db.prepare(`
                SELECT
                    SUM(cost) as total_cost,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as message_count,
                    COUNT(DISTINCT session_id) as session_count
                FROM usage_records
            `);
        }

        const row = (days ? stmt.get(days) : stmt.get()) as {
            total_cost: number | null;
            total_tokens: number | null;
            message_count: number;
            session_count: number;
        };

        return {
            totalCost: row.total_cost || 0,
            totalTokens: row.total_tokens || 0,
            messageCount: row.message_count,
            sessionCount: row.session_count,
        };
    }

    getCostTrend(days: number = 7): Array<{ date: string; cost: number }> {
        const stmt = this.db.prepare(`
            SELECT 
                date(timestamp) as date,
                SUM(cost) as cost
            FROM usage_records
            WHERE date(timestamp) >= date('now', '-' || ? || ' days')
            GROUP BY date(timestamp)
            ORDER BY date ASC
        `);

        const rows = stmt.all(days) as Array<{ date: string; cost: number }>;

        return rows.map((row) => ({
            date: row.date,
            cost: row.cost,
        }));
    }

    getTopModels(limit: number = 10, days?: number): ModelUsage[] {
        let stmt: Statement;
        if (days) {
            stmt = this.db.prepare(`
                SELECT 
                    provider,
                    model,
                    SUM(cost) as total_cost,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as message_count,
                    AVG(cost) as avg_cost_per_message
                FROM usage_records
                WHERE date(timestamp) >= date('now', '-' || ? || ' days')
                GROUP BY provider, model
                ORDER BY total_cost DESC
                LIMIT ?
            `);
        } else {
            stmt = this.db.prepare(`
                SELECT 
                    provider,
                    model,
                    SUM(cost) as total_cost,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as message_count,
                    AVG(cost) as avg_cost_per_message
                FROM usage_records
                GROUP BY provider, model
                ORDER BY total_cost DESC
                LIMIT ?
            `);
        }

        const rows = (days ? stmt.all(days, limit) : stmt.all(limit)) as Array<{
            provider: string;
            model: string;
            total_cost: number;
            total_tokens: number;
            message_count: number;
            avg_cost_per_message: number;
        }>;

        return rows.map((row) => ({
            provider: row.provider,
            model: row.model,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            avgCostPerMessage: row.avg_cost_per_message,
        }));
    }

    close(): void {
        this.db.close();
    }
}

// Singleton instance
export const usageDatabase = new UsageDatabase();
