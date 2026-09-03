import { basename, dirname } from "node:path";
import type { PricingTable } from "../types";
import { totalTokensOf } from "./cost";
import { lastSinceDay, zonedDay } from "./dates";
import { filterEvents, pricedEventCost } from "./load";
import type { CostMode, ModelBreakdownJson, SourceId, SpendEvent } from "./types";

export interface SessionBuildOptions {
    timezone: string;
    sinceDay?: string;
    untilDay?: string;
    last?: number;
    now: Date;
    pricing: PricingTable;
    mode: CostMode;
    source?: SourceId;
    sessionId?: string;
}

interface SessionBucket {
    source: SourceId;
    sessionId: string;
    project: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    reasoningOutputTokens: number;
    firstActivity: string;
    lastActivity: string;
    models: Map<
        string,
        {
            inputTokens: number;
            outputTokens: number;
            cacheCreationTokens: number;
            cacheReadTokens: number;
            cost: number;
            reasoningOutputTokens: number;
        }
    >;
}

export function buildSessionReport(events: SpendEvent[], options: SessionBuildOptions): Record<string, unknown> {
    const today = zonedDay(options.now.toISOString(), options.timezone);
    let sinceDay = options.sinceDay;

    if (options.last) {
        const lastSince = lastSinceDay("daily", options.last, today);
        sinceDay = sinceDay && sinceDay > lastSince ? sinceDay : lastSince;
    }

    const kept = filterEvents(events, {
        timezone: options.timezone,
        sinceDay,
        untilDay: options.untilDay,
        sessionId: options.sessionId,
    });
    const buckets = new Map<string, SessionBucket>();

    for (const event of kept) {
        const key = `${event.source}:${event.sessionId}`;
        const bucket = buckets.get(key) ?? {
            source: event.source,
            sessionId: event.sessionId,
            project: event.project,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCost: 0,
            reasoningOutputTokens: 0,
            firstActivity: event.timestamp,
            lastActivity: event.timestamp,
            models: new Map(),
        };
        const cost = pricedEventCost(event, options.pricing, options.mode);
        bucket.inputTokens += event.inputTokens;
        bucket.outputTokens += event.outputTokens;
        bucket.cacheCreationTokens += event.cacheCreationTokens;
        bucket.cacheReadTokens += event.cacheReadTokens;
        bucket.totalCost += cost;
        bucket.reasoningOutputTokens += event.reasoningOutputTokens ?? 0;

        if (event.timestamp < bucket.firstActivity) {
            bucket.firstActivity = event.timestamp;
        }

        if (event.timestamp > bucket.lastActivity) {
            bucket.lastActivity = event.timestamp;
        }

        const model = bucket.models.get(event.model) ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cost: 0,
            reasoningOutputTokens: 0,
        };
        model.inputTokens += event.inputTokens;
        model.outputTokens += event.outputTokens;
        model.cacheCreationTokens += event.cacheCreationTokens;
        model.cacheReadTokens += event.cacheReadTokens;
        model.cost += cost;
        model.reasoningOutputTokens += event.reasoningOutputTokens ?? 0;
        bucket.models.set(event.model, model);
        buckets.set(key, bucket);
    }

    const rows = [...buckets.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    const totals = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        reasoningOutputTokens: 0,
        costUSD: 0,
    };

    for (const row of rows) {
        totals.inputTokens += row.inputTokens;
        totals.outputTokens += row.outputTokens;
        totals.cacheCreationTokens += row.cacheCreationTokens;
        totals.cacheReadTokens += row.cacheReadTokens;
        totals.totalCost += row.totalCost;
        totals.reasoningOutputTokens += row.reasoningOutputTokens;
    }

    totals.totalTokens = totalTokensOf(totals);
    totals.costUSD = totals.totalCost;

    const unified = !options.source;

    if (unified) {
        return {
            session: rows.map((row) => ({
                agent: row.source,
                cacheCreationTokens: row.cacheCreationTokens,
                cacheReadTokens: row.cacheReadTokens,
                inputTokens: row.inputTokens,
                metadata: { lastActivity: row.lastActivity },
                modelBreakdowns: breakdowns(row),
                modelsUsed: [...row.models.keys()].sort(),
                outputTokens: row.outputTokens,
                period: row.sessionId,
                totalCost: row.totalCost,
                totalTokens: totalTokensOf(row),
            })),
            totals: {
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                cacheCreationTokens: totals.cacheCreationTokens,
                cacheReadTokens: totals.cacheReadTokens,
                totalTokens: totals.totalTokens,
                totalCost: totals.totalCost,
            },
        };
    }

    if (options.source === "codex") {
        return {
            sessions: rows.map((row) => {
                const models: Record<string, unknown> = {};

                for (const [name, model] of [...row.models.entries()].sort(([a], [b]) => a.localeCompare(b))) {
                    models[name] = {
                        cacheCreationTokens: model.cacheCreationTokens,
                        cacheReadTokens: model.cacheReadTokens,
                        inputTokens: model.inputTokens,
                        isFallback: false,
                        outputTokens: model.outputTokens,
                        reasoningOutputTokens: model.reasoningOutputTokens,
                        totalTokens: totalTokensOf(model),
                    };
                }

                const slash = row.sessionId.lastIndexOf("/");
                return {
                    sessionId: row.sessionId,
                    cacheCreationTokens: row.cacheCreationTokens,
                    cacheReadTokens: row.cacheReadTokens,
                    costUSD: row.totalCost,
                    inputTokens: row.inputTokens,
                    models,
                    outputTokens: row.outputTokens,
                    reasoningOutputTokens: row.reasoningOutputTokens,
                    totalTokens: totalTokensOf(row),
                    lastActivity: row.lastActivity,
                    sessionFile: slash >= 0 ? row.sessionId.slice(slash + 1) : basename(row.sessionId),
                    directory: slash >= 0 ? row.sessionId.slice(0, slash) : dirname(row.project),
                };
            }),
            totals: {
                cacheCreationTokens: totals.cacheCreationTokens,
                cacheReadTokens: totals.cacheReadTokens,
                costUSD: totals.costUSD,
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                reasoningOutputTokens: totals.reasoningOutputTokens,
                totalTokens: totals.totalTokens,
            },
        };
    }

    return {
        sessions: rows.map((row) => ({
            sessionId: row.sessionId,
            cacheCreationTokens: row.cacheCreationTokens,
            cacheReadTokens: row.cacheReadTokens,
            inputTokens: row.inputTokens,
            modelBreakdowns: breakdowns(row),
            modelsUsed: [...row.models.keys()].sort(),
            outputTokens: row.outputTokens,
            totalCost: row.totalCost,
            totalTokens: totalTokensOf(row),
            lastActivity: row.lastActivity,
            firstActivity: row.firstActivity,
            projectPath: row.project,
        })),
        totals: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheCreationTokens: totals.cacheCreationTokens,
            cacheReadTokens: totals.cacheReadTokens,
            totalTokens: totals.totalTokens,
            totalCost: totals.totalCost,
        },
    };
}

function breakdowns(row: SessionBucket): ModelBreakdownJson[] {
    return [...row.models.entries()]
        .map(([modelName, model]) => ({
            modelName,
            inputTokens: model.inputTokens,
            outputTokens: model.outputTokens,
            cacheCreationTokens: model.cacheCreationTokens,
            cacheReadTokens: model.cacheReadTokens,
            cost: model.cost,
        }))
        .sort((a, b) => b.cost - a.cost || a.modelName.localeCompare(b.modelName));
}
