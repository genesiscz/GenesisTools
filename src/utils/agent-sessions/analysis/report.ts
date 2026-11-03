import {
    type CacheCall,
    type CacheLoss,
    type CacheSummary,
    findCacheLosses,
    summarizeCache,
} from "@genesiscz/utils/ai/usage/cache-stats";
import type { SessionCall, SessionCompaction, SessionFacts } from "../analysis-types";
import { callCostUsd, priceOfCall } from "./cost";

/**
 * The provider-neutral session report (design 2026-11-01, proposal 2, first in the port order): what a session cost,
 * where its tokens went, which calls were expensive and why, and where its cache was lost. It reads only the
 * `analysis` facts of a reader, so Claude, Codex and Grok get the same report from their own formats.
 */
export const SESSIONS_REPORT_SCHEMA = "sessions.report@1";

/** Why one call stands out. The thresholds follow the session-analyzer skill's tags. */
export type CallTag =
    | "cold-cache"
    | "partial-cold"
    | "large-cache-write"
    | "high-output"
    | "very-high-output"
    | "subagent";

export interface ReportModel {
    model: string;
    calls: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    /** Null when the catalog has no rate for the model: the session's total then misses it. */
    costUsd: number | null;
}

export interface ReportCall {
    index: number;
    t: string;
    model: string;
    context: number;
    output: number;
    costUsd: number | null;
    tags: CallTag[];
}

export interface SessionReport {
    overview: {
        first: string | null;
        last: string | null;
        durationMinutes: number;
        calls: number;
        models: string[];
        compactions: number | null;
        /** Calls the harness wrote for its sub-agents inside this transcript. */
        subagentCalls: number;
    };
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    cost: {
        totalUsd: number;
        mainUsd: number;
        subagentUsd: number;
        /** The same calls with no cache at all: every cached token billed as input. */
        noCacheUsd: number;
        savingsUsd: number;
        /** Models with no known rate: their calls are not in the dollars. */
        unpricedModels: string[];
    };
    /** Tokens the way a subscription window weighs them: cache reads count a tenth. */
    quotaWeight: number;
    models: ReportModel[];
    cache: CacheSummary;
    losses: CacheLoss[];
    /** The costliest calls with their tags, most expensive first. */
    topCalls: ReportCall[];
    /** The longest pauses between two calls, longest first. */
    gaps: Array<{ after: string; minutes: number }>;
    /** Facts the harness cannot answer, by name, with its reason. */
    unsupported: Record<string, string>;
}

const LARGE_WRITE = 50_000;
const HIGH_OUTPUT = 8_000;
const VERY_HIGH_OUTPUT = 32_000;
const GAP_MINUTES = 10;

function tagsOf(call: SessionCall, previous: SessionCall | undefined): CallTag[] {
    const tags: CallTag[] = [];
    const context = call.input + call.cacheRead + call.cacheWrite;

    if (previous && context > 20_000 && !call.aggregate) {
        if (call.cacheRead === 0 && call.cacheWrite > 0.5 * context) {
            tags.push("cold-cache");
        } else if (call.cacheWrite > 0.3 * context) {
            tags.push("partial-cold");
        }
    }

    if (call.cacheWrite >= LARGE_WRITE) {
        tags.push("large-cache-write");
    }

    if (call.output >= VERY_HIGH_OUTPUT) {
        tags.push("very-high-output");
    } else if (call.output >= HIGH_OUTPUT) {
        tags.push("high-output");
    }

    if (call.sidechain) {
        tags.push("subagent");
    }

    return tags;
}

/** The calls of one session in cache-stats terms; the call just before a compaction carries the flag. */
export function cacheCallsOf(calls: readonly SessionCall[], compactions: readonly SessionCompaction[]): CacheCall[] {
    const marks = compactions.map((compaction) => Date.parse(compaction.t));
    // The cache a call reads lives as long as the last write said: a one-hour write survives a 10-minute gap.
    let ttl: CacheCall["ttl"];

    return calls.map((call, index) => {
        const at = Date.parse(call.t);
        const next = calls[index + 1];
        const nextAt = next ? Date.parse(next.t) : Number.POSITIVE_INFINITY;
        const lifetime = ttl;

        if (call.cacheWrite > 0 && call.cacheWrite1h !== undefined) {
            ttl = call.cacheWrite1h >= call.cacheWrite ? "1h" : call.cacheWrite1h > 0 ? "mixed" : "5m";
        }

        return {
            t: at,
            model: call.model,
            input: call.input,
            cacheRead: call.cacheRead,
            cacheWrite: call.cacheWrite,
            output: call.output,
            ...(lifetime === undefined ? {} : { ttl: lifetime }),
            compaction: marks.some((mark) => mark >= at && mark <= nextAt),
        };
    });
}

function noCacheCost(call: SessionCall): number {
    const price = priceOfCall(call);
    return price
        ? ((call.input + call.cacheRead + call.cacheWrite) * price.input + call.output * price.output) / 1e6
        : 0;
}

export function buildSessionReport(input: {
    calls: SessionFacts<SessionCall>;
    compactions: SessionFacts<SessionCompaction>;
    top?: number;
}): SessionReport {
    const calls = input.calls.supported ? input.calls.items : [];
    const compactions = input.compactions.supported ? input.compactions.items : [];
    const unsupported: Record<string, string> = {};

    if (!input.calls.supported) {
        unsupported.callTrace = input.calls.reason;
    }

    if (!input.compactions.supported) {
        unsupported.compactions = input.compactions.reason;
    }

    const models = new Map<string, ReportModel>();
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const cost = {
        totalUsd: 0,
        mainUsd: 0,
        subagentUsd: 0,
        noCacheUsd: 0,
        savingsUsd: 0,
        unpricedModels: [] as string[],
    };
    const rows: ReportCall[] = [];
    const gaps: SessionReport["gaps"] = [];
    // The main loop and the sub-agents are separate caches; a loss is only judged against the same loop.
    const main = calls.filter((call) => !call.sidechain);
    let lastMain: SessionCall | undefined;

    calls.forEach((call, index) => {
        const usd = callCostUsd(call);
        const model = models.get(call.model) ?? {
            model: call.model,
            calls: 0,
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            costUsd: 0,
        };
        model.calls += 1;
        model.input += call.input;
        model.cacheRead += call.cacheRead;
        model.cacheWrite += call.cacheWrite;
        model.output += call.output;
        model.costUsd = usd === null || model.costUsd === null ? null : model.costUsd + usd;
        models.set(call.model, model);
        tokens.input += call.input;
        tokens.cacheRead += call.cacheRead;
        tokens.cacheWrite += call.cacheWrite;
        tokens.output += call.output;

        if (usd !== null) {
            cost.totalUsd += usd;
            cost.noCacheUsd += noCacheCost(call);

            if (call.sidechain) {
                cost.subagentUsd += usd;
            } else {
                cost.mainUsd += usd;
            }
        }

        const previous = call.sidechain ? undefined : lastMain;

        if (!call.sidechain) {
            lastMain = call;
        }

        rows.push({
            index,
            t: call.t,
            model: call.model,
            context: call.input + call.cacheRead + call.cacheWrite,
            output: call.output,
            costUsd: usd,
            tags: tagsOf(call, previous),
        });

        if (previous) {
            const minutes = (Date.parse(call.t) - Date.parse(previous.t)) / 60_000;

            if (minutes >= GAP_MINUTES) {
                gaps.push({ after: previous.t, minutes: Math.round(minutes) });
            }
        }
    });

    cost.unpricedModels = [...models.values()].filter((model) => model.costUsd === null).map((model) => model.model);
    cost.savingsUsd = cost.noCacheUsd - cost.totalUsd;
    const cacheCalls = cacheCallsOf(
        main.filter((call) => !call.aggregate),
        compactions
    );
    const losses = findCacheLosses(cacheCalls);
    const first = calls[0]?.t ?? null;
    const last = calls.at(-1)?.t ?? null;

    return {
        overview: {
            first,
            last,
            durationMinutes: first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60_000) : 0,
            calls: calls.length,
            models: [...models.keys()],
            compactions: input.compactions.supported ? compactions.length : null,
            subagentCalls: calls.length - main.length,
        },
        tokens,
        cost,
        quotaWeight: tokens.input + tokens.cacheWrite + tokens.output + tokens.cacheRead * 0.1,
        models: [...models.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
        cache: summarizeCache(cacheCalls, losses.length),
        losses,
        topCalls: rows
            .filter((row) => row.costUsd !== null)
            .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
            .slice(0, input.top ?? 10),
        gaps: gaps.sort((a, b) => b.minutes - a.minutes).slice(0, 10),
        unsupported,
    };
}
