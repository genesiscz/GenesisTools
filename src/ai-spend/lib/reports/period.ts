import type { PricingTable } from "../types";
import { totalTokensOf } from "./cost";
import { lastSinceDay, periodFieldName, periodKey, zonedDay } from "./dates";
import { filterEvents, pricedEventCost } from "./load";
import type { CostMode, ModelBreakdownJson, PeriodGrain, SourceId, SpendEvent, TokenTotalsJson } from "./types";

export interface PeriodBuildOptions {
    grain: PeriodGrain;
    timezone: string;
    sinceDay?: string;
    untilDay?: string;
    last?: number;
    now: Date;
    pricing: PricingTable;
    mode: CostMode;
    source?: SourceId;
    byAgent?: boolean;
}

interface Bucket {
    key: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    reasoningOutputTokens: number;
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
    agents: Set<SourceId>;
    lastActivity: string;
    firstActivity: string;
    sourceCosts: Map<SourceId, Bucket>;
}

function emptyBucket(key: string): Bucket {
    return {
        key,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0,
        reasoningOutputTokens: 0,
        models: new Map(),
        agents: new Set(),
        lastActivity: "",
        firstActivity: "",
        sourceCosts: new Map(),
    };
}

function addToBucket(bucket: Bucket, event: SpendEvent, cost: number): void {
    bucket.inputTokens += event.inputTokens;
    bucket.outputTokens += event.outputTokens;
    bucket.cacheCreationTokens += event.cacheCreationTokens;
    bucket.cacheReadTokens += event.cacheReadTokens;
    bucket.totalCost += cost;
    bucket.reasoningOutputTokens += event.reasoningOutputTokens ?? 0;
    bucket.agents.add(event.source);

    if (!bucket.firstActivity || event.timestamp < bucket.firstActivity) {
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
}

function modelBreakdowns(bucket: Bucket): ModelBreakdownJson[] {
    return [...bucket.models.entries()]
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

function totalsOf(buckets: Bucket[]): TokenTotalsJson {
    const totals: TokenTotalsJson = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
    };

    for (const bucket of buckets) {
        totals.inputTokens += bucket.inputTokens;
        totals.outputTokens += bucket.outputTokens;
        totals.cacheCreationTokens += bucket.cacheCreationTokens;
        totals.cacheReadTokens += bucket.cacheReadTokens;
        totals.totalCost += bucket.totalCost;
    }

    totals.totalTokens = totalTokensOf(totals);
    return totals;
}

export function buildPeriodReport(events: SpendEvent[], options: PeriodBuildOptions): Record<string, unknown> {
    const today = zonedDay(options.now.toISOString(), options.timezone);
    let sinceDay = options.sinceDay;

    if (options.last) {
        const lastSince = lastSinceDay(options.grain, options.last, today);
        sinceDay = sinceDay && sinceDay > lastSince ? sinceDay : lastSince;
    }

    const kept = filterEvents(events, { timezone: options.timezone, sinceDay, untilDay: options.untilDay });
    const buckets = new Map<string, Bucket>();

    for (const event of kept) {
        const day = zonedDay(event.timestamp, options.timezone);
        const key = periodKey(day, options.grain);
        const bucket = buckets.get(key) ?? emptyBucket(key);
        const cost = pricedEventCost(event, options.pricing, options.mode);
        addToBucket(bucket, event, cost);

        if (options.byAgent) {
            const per = bucket.sourceCosts.get(event.source) ?? emptyBucket(key);
            addToBucket(per, event, cost);
            bucket.sourceCosts.set(event.source, per);
        }

        buckets.set(key, bucket);
    }

    const rows = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
    const grainKey = options.grain;
    const unified = !options.source;

    if (unified) {
        return {
            [grainKey]: rows.map((bucket) => {
                const row: Record<string, unknown> = {
                    agent: "all",
                    cacheCreationTokens: bucket.cacheCreationTokens,
                    cacheReadTokens: bucket.cacheReadTokens,
                    inputTokens: bucket.inputTokens,
                    metadata: { agents: [...bucket.agents].sort() },
                    modelBreakdowns: modelBreakdowns(bucket),
                    modelsUsed: [...bucket.models.keys()].sort(),
                    outputTokens: bucket.outputTokens,
                    period: bucket.key,
                    totalCost: bucket.totalCost,
                    totalTokens: totalTokensOf(bucket),
                };

                if (options.byAgent) {
                    row.agents = [...bucket.sourceCosts.entries()]
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([agent, per]) => ({
                            agent,
                            cacheCreationTokens: per.cacheCreationTokens,
                            cacheReadTokens: per.cacheReadTokens,
                            inputTokens: per.inputTokens,
                            modelBreakdowns: modelBreakdowns(per),
                            modelsUsed: [...per.models.keys()].sort(),
                            outputTokens: per.outputTokens,
                            totalCost: per.totalCost,
                            totalTokens: totalTokensOf(per),
                        }));
                }

                return row;
            }),
            totals: totalsOf(rows),
        };
    }

    if (options.source === "codex") {
        return {
            [grainKey]: rows.map((bucket) => {
                const models: Record<string, unknown> = {};

                for (const [name, model] of [...bucket.models.entries()].sort(([a], [b]) => a.localeCompare(b))) {
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

                return {
                    [periodFieldName(options.grain)]: bucket.key,
                    cacheCreationTokens: bucket.cacheCreationTokens,
                    cacheReadTokens: bucket.cacheReadTokens,
                    costUSD: bucket.totalCost,
                    inputTokens: bucket.inputTokens,
                    models,
                    outputTokens: bucket.outputTokens,
                    reasoningOutputTokens: bucket.reasoningOutputTokens,
                    totalTokens: totalTokensOf(bucket),
                };
            }),
            totals: {
                cacheCreationTokens: totalsOf(rows).cacheCreationTokens,
                cacheReadTokens: totalsOf(rows).cacheReadTokens,
                costUSD: totalsOf(rows).totalCost,
                inputTokens: totalsOf(rows).inputTokens,
                outputTokens: totalsOf(rows).outputTokens,
                reasoningOutputTokens: rows.reduce((sum, row) => sum + row.reasoningOutputTokens, 0),
                totalTokens: totalsOf(rows).totalTokens,
            },
        };
    }

    return {
        [grainKey]: rows.map((bucket) => ({
            [periodFieldName(options.grain)]: bucket.key,
            cacheCreationTokens: bucket.cacheCreationTokens,
            cacheReadTokens: bucket.cacheReadTokens,
            inputTokens: bucket.inputTokens,
            modelBreakdowns: modelBreakdowns(bucket),
            modelsUsed: [...bucket.models.keys()].sort(),
            outputTokens: bucket.outputTokens,
            totalCost: bucket.totalCost,
            totalTokens: totalTokensOf(bucket),
        })),
        totals: totalsOf(rows),
    };
}
