import type { PricingTable } from "../types";
import { totalTokensOf } from "./cost";
import { addDays, zonedDay } from "./dates";
import { pricedEventCost } from "./load";
import type { CostMode, SpendEvent } from "./types";

const MILLIS_PER_HOUR = 3_600_000;
const MILLIS_PER_MINUTE = 60_000;
const DEFAULT_HOURS = 5;

export interface BlocksBuildOptions {
    timezone: string;
    sinceDay?: string;
    untilDay?: string;
    now: Date;
    pricing: PricingTable;
    mode: CostMode;
    active?: boolean;
    recent?: boolean;
    sessionHours?: number;
}

export interface SessionBlock {
    id: string;
    startTime: string;
    endTime: string;
    actualEndTime: string | null;
    isActive: boolean;
    isGap: boolean;
    entries: number;
    models: string[];
    tokenCounts: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens: number;
        cacheReadInputTokens: number;
    };
    totalTokens: number;
    costUSD: number;
    modelBreakdowns: Array<{
        modelName: string;
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        cost: number;
    }>;
    burnRate: { tokensPerMinute: number; tokensPerMinuteForIndicator: number; costPerHour: number } | null;
    projection: { totalTokens: number; totalCost: number; remainingMinutes: number } | null;
}

function floorToHour(ms: number): number {
    return Math.floor(ms / MILLIS_PER_HOUR) * MILLIS_PER_HOUR;
}

function rfc3339(ms: number): string {
    return new Date(ms).toISOString();
}

export function identifySessionBlocks(
    events: SpendEvent[],
    sessionHours: number,
    nowMs: number,
    costOf: (event: SpendEvent) => number
): SessionBlock[] {
    if (events.length === 0) {
        return [];
    }

    const duration = sessionHours * MILLIS_PER_HOUR;
    const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const blocks: SessionBlock[] = [];
    let currentStart: number | undefined;
    let current: SpendEvent[] = [];

    const flush = (start: number, entries: SpendEvent[], gapNext?: number): void => {
        if (entries.length > 0) {
            blocks.push(createBlock(start, entries, nowMs, duration, costOf));
        }

        if (gapNext !== undefined) {
            const last = Date.parse(entries[entries.length - 1]?.timestamp ?? rfc3339(start));
            blocks.push(createGap(last + duration, gapNext, duration));
        }
    };

    for (const event of sorted) {
        const ts = Date.parse(event.timestamp);

        if (Number.isNaN(ts)) {
            continue;
        }

        if (currentStart === undefined) {
            currentStart = floorToHour(ts);
            current.push(event);
            continue;
        }

        const last = Date.parse(current[current.length - 1]?.timestamp ?? rfc3339(currentStart));
        const sinceStart = ts - currentStart;
        const sinceLast = ts - last;

        if (sinceStart > duration || sinceLast > duration) {
            flush(currentStart, current, sinceLast > duration ? ts : undefined);
            current = [];
            currentStart = floorToHour(ts);
        }

        current.push(event);
    }

    if (currentStart !== undefined && current.length > 0) {
        flush(currentStart, current);
    }

    return blocks;
}

function createBlock(
    start: number,
    entries: SpendEvent[],
    nowMs: number,
    duration: number,
    costOf: (event: SpendEvent) => number
): SessionBlock {
    const end = start + duration;
    const last = Date.parse(entries[entries.length - 1].timestamp);
    const isActive = nowMs - last < duration && nowMs < end;
    const models: string[] = [];
    const seen = new Set<string>();
    const perModel = new Map<
        string,
        {
            inputTokens: number;
            outputTokens: number;
            cacheCreationTokens: number;
            cacheReadTokens: number;
            cost: number;
        }
    >();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let costUSD = 0;

    for (const event of entries) {
        const eventCostUsd = costOf(event);
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        cacheCreationInputTokens += event.cacheCreationTokens;
        cacheReadInputTokens += event.cacheReadTokens;
        costUSD += eventCostUsd;

        if (!seen.has(event.model)) {
            seen.add(event.model);
            models.push(event.model);
        }

        const model = perModel.get(event.model) ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cost: 0,
        };
        model.inputTokens += event.inputTokens;
        model.outputTokens += event.outputTokens;
        model.cacheCreationTokens += event.cacheCreationTokens;
        model.cacheReadTokens += event.cacheReadTokens;
        model.cost += eventCostUsd;
        perModel.set(event.model, model);
    }

    const modelBreakdowns = [...perModel.entries()]
        .map(([modelName, model]) => ({ modelName, ...model }))
        .sort((a, b) => b.cost - a.cost || a.modelName.localeCompare(b.modelName));

    const tokenCounts = { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
    const totalTokens = totalTokensOf({
        inputTokens,
        outputTokens,
        cacheCreationTokens: cacheCreationInputTokens,
        cacheReadTokens: cacheReadInputTokens,
    });
    let burnRate: SessionBlock["burnRate"] = null;
    let projection: SessionBlock["projection"] = null;

    if (isActive) {
        const elapsedMinutes = Math.max((last - start) / MILLIS_PER_MINUTE, 1);
        const remainingMinutes = Math.max((end - nowMs) / MILLIS_PER_MINUTE, 0);
        const tokensPerMinute = totalTokens / elapsedMinutes;
        burnRate = {
            tokensPerMinute,
            tokensPerMinuteForIndicator: tokensPerMinute,
            costPerHour: (costUSD / elapsedMinutes) * 60,
        };
        projection = {
            totalTokens: Math.round(totalTokens + tokensPerMinute * remainingMinutes),
            totalCost: costUSD + burnRate.costPerHour * (remainingMinutes / 60),
            remainingMinutes: Math.round(remainingMinutes),
        };
    }

    return {
        id: rfc3339(start),
        startTime: rfc3339(start),
        endTime: rfc3339(end),
        actualEndTime: rfc3339(last),
        isActive,
        isGap: false,
        entries: entries.length,
        models,
        tokenCounts,
        totalTokens,
        costUSD,
        modelBreakdowns,
        burnRate,
        projection,
    };
}

function createGap(start: number, next: number, _duration: number): SessionBlock {
    return {
        id: `gap-${rfc3339(start)}`,
        startTime: rfc3339(start),
        endTime: rfc3339(next),
        actualEndTime: null,
        isActive: false,
        isGap: true,
        entries: 0,
        models: [],
        tokenCounts: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        totalTokens: 0,
        costUSD: 0,
        modelBreakdowns: [],
        burnRate: null,
        projection: null,
    };
}

export function buildBlocksReport(events: SpendEvent[], options: BlocksBuildOptions): { blocks: SessionBlock[] } {
    let sinceDay = options.sinceDay;
    const today = zonedDay(options.now.toISOString(), options.timezone);

    if (options.recent) {
        const recentSince = addDays(today, -2);
        sinceDay = sinceDay && sinceDay > recentSince ? sinceDay : recentSince;
    }

    const hours = options.sessionHours && options.sessionHours > 0 ? options.sessionHours : DEFAULT_HOURS;
    let blocks = identifySessionBlocks(events, hours, options.now.getTime(), (event) =>
        pricedEventCost(event, options.pricing, options.mode)
    );

    if (sinceDay || options.untilDay) {
        blocks = blocks.filter((block) => {
            const day = zonedDay(block.startTime, options.timezone);
            if (sinceDay && day < sinceDay) {
                return false;
            }

            if (options.untilDay && day > options.untilDay) {
                return false;
            }

            return true;
        });
    }

    if (options.active) {
        blocks = blocks.filter((block) => block.isActive && !block.isGap);
    }

    return { blocks };
}
