import { getAskDatabase, openAskDatabase } from "@app/ask/lib/db";
import type { AskDB } from "@app/ask/lib/db-types";
import { usageCacheReadTokens, usageCacheWriteTokens, usageInputNoCacheTokens } from "@ask/utils/helpers";
import type { DatabaseClient } from "@genesiscz/utils/database";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { LanguageModelUsage } from "ai";
import { sql } from "kysely";

export interface UsageScope {
    /** Whole days back from today; undefined means the full history. */
    days?: number;
    provider?: string;
    model?: string;
}

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

const sinceDays = (days: number) => sql<string>`date('now', ${`-${days} days`})`;

export class UsageDatabase {
    private opened: DatabaseClient<AskDB> | null = null;

    /** The module-level instance below is built at import, so the file opens on first use: `tools ask --help` must write nothing (#446). */
    constructor(private readonly dbPath?: string) {}

    private get client(): DatabaseClient<AskDB> {
        if (!this.opened) {
            this.opened = this.dbPath ? openAskDatabase(this.dbPath) : getAskDatabase();
        }

        return this.opened;
    }

    async recordUsage(
        sessionId: string,
        provider: string,
        model: string,
        usage: LanguageModelUsage,
        cost: number,
        messageIndex?: number
    ): Promise<number> {
        logger.debug(`[UsageDatabase] recordUsage called for ${provider}/${model}`);
        logger.debug({ usage: SafeJSON.stringify(usage, null, 2) }, `[UsageDatabase] usage object`);

        const inputTokens = usageInputNoCacheTokens(usage);
        const outputTokens = usage.outputTokens ?? 0;
        const cachedInputTokens = usageCacheReadTokens(usage);
        const cacheWriteTokens = usageCacheWriteTokens(usage);
        const totalTokens = usage.totalTokens ?? inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens;

        logger.debug(
            { inputTokens, outputTokens, cachedInputTokens, totalTokens, cost },
            `[UsageDatabase] Storing tokens`
        );

        const result = await this.client.kysely
            .insertInto("usage_records")
            .values({
                session_id: sessionId,
                provider,
                model,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cached_input_tokens: cachedInputTokens,
                total_tokens: totalTokens,
                cost,
                timestamp: new Date().toISOString(),
                message_index: messageIndex ?? null,
            })
            .executeTakeFirstOrThrow();

        const id = Number(result.insertId ?? 0);
        logger.debug(`[UsageDatabase] Record inserted with ID: ${id}`);

        return id;
    }

    private usageQuery(scope: number | UsageScope | undefined) {
        const filters = typeof scope === "number" ? { days: scope } : (scope ?? {});
        let query = this.client.kysely.selectFrom("usage_records");
        if (filters.days !== undefined) {
            // SQLite turns a malformed date modifier into NULL, which matches no row and reads as "no usage".
            if (!Number.isFinite(filters.days) || filters.days < 0) {
                throw new Error(`Usage days must be a finite number of 0 or more, got ${filters.days}`);
            }

            query = query.where(sql<string>`date(timestamp)`, ">=", sinceDays(filters.days));
        }
        if (filters.provider) {
            query = query.where("provider", "=", filters.provider);
        }
        if (filters.model) {
            query = query.where("model", "=", filters.model);
        }
        return query;
    }

    async getDailyUsage(scope: number | UsageScope = 30): Promise<DailyUsage[]> {
        const rows = await this.usageQuery(scope)
            .select([
                sql<string>`date(timestamp)`.as("date"),
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`COUNT(DISTINCT provider)`.as("provider_count"),
            ])

            .groupBy(sql`date(timestamp)`)
            .orderBy("date", "desc")
            .execute();

        return rows.map((row) => ({
            date: row.date,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            providerCount: row.provider_count,
        }));
    }

    async getProviderUsage(scope: number | UsageScope = 30): Promise<ProviderUsage[]> {
        const rows = await this.usageQuery(scope)
            .select([
                "provider",
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`AVG(cost)`.as("avg_cost_per_message"),
            ])

            .groupBy("provider")
            .orderBy("total_cost", "desc")
            .execute();

        return rows.map((row) => ({
            provider: row.provider,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            avgCostPerMessage: row.avg_cost_per_message,
        }));
    }

    async getModelUsage(scope: number | UsageScope = 30): Promise<ModelUsage[]> {
        const rows = await this.usageQuery(scope)
            .select([
                "provider",
                "model",
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`AVG(cost)`.as("avg_cost_per_message"),
            ])

            .groupBy("provider")
            .groupBy("model")
            .orderBy("total_cost", "desc")
            .execute();

        return rows.map((row) => ({
            provider: row.provider,
            model: row.model,
            totalCost: row.total_cost,
            totalTokens: row.total_tokens,
            messageCount: row.message_count,
            avgCostPerMessage: row.avg_cost_per_message,
        }));
    }

    async getSessionUsage(sessionId: string): Promise<UsageRecord[]> {
        const rows = await this.client.kysely
            .selectFrom("usage_records")
            .select([
                "id",
                "session_id",
                "provider",
                "model",
                "input_tokens",
                "output_tokens",
                "cached_input_tokens",
                "total_tokens",
                "cost",
                "timestamp",
                "message_index",
            ])
            .where("session_id", "=", sessionId)
            .orderBy("timestamp", "asc")
            .execute();

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

    async getTotalUsage(scope?: number | UsageScope): Promise<{
        totalCost: number;
        totalTokens: number;
        messageCount: number;
        sessionCount: number;
    }> {
        const query = this.usageQuery(scope).select([
            sql<number | null>`SUM(cost)`.as("total_cost"),
            sql<number | null>`SUM(total_tokens)`.as("total_tokens"),
            sql<number>`COUNT(*)`.as("message_count"),
            sql<number>`COUNT(DISTINCT session_id)`.as("session_count"),
        ]);

        const row = await query.executeTakeFirstOrThrow();

        return {
            totalCost: row.total_cost ?? 0,
            totalTokens: row.total_tokens ?? 0,
            messageCount: row.message_count,
            sessionCount: row.session_count,
        };
    }

    async getCostTrend(scope: number | UsageScope = 7): Promise<Array<{ date: string; cost: number }>> {
        const rows = await this.usageQuery(scope)
            .select([sql<string>`date(timestamp)`.as("date"), sql<number>`SUM(cost)`.as("cost")])

            .groupBy(sql`date(timestamp)`)
            .orderBy("date", "asc")
            .execute();

        return rows.map((row) => ({ date: row.date, cost: row.cost }));
    }

    async getTopModels(limit = 10, scope?: number | UsageScope): Promise<ModelUsage[]> {
        const query = this.usageQuery(scope).select([
            "provider",
            "model",
            sql<number>`SUM(cost)`.as("total_cost"),
            sql<number>`SUM(total_tokens)`.as("total_tokens"),
            sql<number>`COUNT(*)`.as("message_count"),
            sql<number>`AVG(cost)`.as("avg_cost_per_message"),
        ]);

        const rows = await query
            .groupBy("provider")
            .groupBy("model")
            .orderBy("total_cost", "desc")
            .limit(limit)
            .execute();

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
        this.client.close();
    }
}

export const usageDatabase = new UsageDatabase();
