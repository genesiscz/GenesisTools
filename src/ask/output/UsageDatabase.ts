import { getAskDatabase, openAskDatabase } from "@app/ask/lib/db";
import type { AskDB } from "@app/ask/lib/db-types";
import logger from "@app/logger";
import type { DatabaseClient } from "@app/utils/database";
import { SafeJSON } from "@app/utils/json";
import type { LanguageModelUsage } from "ai";
import { sql } from "kysely";

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
    private readonly client: DatabaseClient<AskDB>;

    constructor(dbPath?: string) {
        this.client = dbPath ? openAskDatabase(dbPath) : getAskDatabase();
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

        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cachedInputTokens = usage.cachedInputTokens ?? 0;
        const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

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

    async getDailyUsage(days = 30): Promise<DailyUsage[]> {
        const rows = await this.client.kysely
            .selectFrom("usage_records")
            .select([
                sql<string>`date(timestamp)`.as("date"),
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`COUNT(DISTINCT provider)`.as("provider_count"),
            ])
            .where(sql<string>`date(timestamp)`, ">=", sinceDays(days))
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

    async getProviderUsage(days = 30): Promise<ProviderUsage[]> {
        const rows = await this.client.kysely
            .selectFrom("usage_records")
            .select([
                "provider",
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`AVG(cost)`.as("avg_cost_per_message"),
            ])
            .where(sql<string>`date(timestamp)`, ">=", sinceDays(days))
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

    async getModelUsage(days = 30): Promise<ModelUsage[]> {
        const rows = await this.client.kysely
            .selectFrom("usage_records")
            .select([
                "provider",
                "model",
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`AVG(cost)`.as("avg_cost_per_message"),
            ])
            .where(sql<string>`date(timestamp)`, ">=", sinceDays(days))
            .groupBy(["provider", "model"])
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

    async getTotalUsage(days?: number): Promise<{
        totalCost: number;
        totalTokens: number;
        messageCount: number;
        sessionCount: number;
    }> {
        let query = this.client.kysely
            .selectFrom("usage_records")
            .select([
                sql<number | null>`SUM(cost)`.as("total_cost"),
                sql<number | null>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`COUNT(DISTINCT session_id)`.as("session_count"),
            ]);

        if (days) {
            query = query.where(sql<string>`date(timestamp)`, ">=", sinceDays(days));
        }

        const row = await query.executeTakeFirstOrThrow();

        return {
            totalCost: row.total_cost ?? 0,
            totalTokens: row.total_tokens ?? 0,
            messageCount: row.message_count,
            sessionCount: row.session_count,
        };
    }

    async getCostTrend(days = 7): Promise<Array<{ date: string; cost: number }>> {
        const rows = await this.client.kysely
            .selectFrom("usage_records")
            .select([sql<string>`date(timestamp)`.as("date"), sql<number>`SUM(cost)`.as("cost")])
            .where(sql<string>`date(timestamp)`, ">=", sinceDays(days))
            .groupBy(sql`date(timestamp)`)
            .orderBy("date", "asc")
            .execute();

        return rows.map((row) => ({ date: row.date, cost: row.cost }));
    }

    async getTopModels(limit = 10, days?: number): Promise<ModelUsage[]> {
        let query = this.client.kysely
            .selectFrom("usage_records")
            .select([
                "provider",
                "model",
                sql<number>`SUM(cost)`.as("total_cost"),
                sql<number>`SUM(total_tokens)`.as("total_tokens"),
                sql<number>`COUNT(*)`.as("message_count"),
                sql<number>`AVG(cost)`.as("avg_cost_per_message"),
            ]);

        if (days) {
            query = query.where(sql<string>`date(timestamp)`, ">=", sinceDays(days));
        }

        const rows = await query.groupBy(["provider", "model"]).orderBy("total_cost", "desc").limit(limit).execute();

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
