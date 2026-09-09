import { basename, dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isRecord, num } from "./parse-helpers";
import type { CreateParserOptions, DriverLineParser, DriverUsageEvent } from "./types";

const COST_USD_TICKS_PER_USD = 1e10;
const MAX_EPOCH_MS = 8.64e15;
interface GrokModelUsage {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    costUsdTicks?: number;
}
interface GrokUsage extends GrokModelUsage {
    modelUsage?: Record<string, GrokModelUsage>;
}
interface GrokLine {
    timestamp?: number;
    params?: {
        sessionId?: string;
        update?: { sessionUpdate?: string; usage?: GrokUsage };
        _meta?: { eventId?: string; agentTimestampMs?: number };
    };
}
export interface CreateGrokParserOptions extends CreateParserOptions {
    currentModel?: string;
    resolveCurrentModel?: () => string | undefined;
}

/**
 * ISO-8601 for an epoch, or "" when the record's clock is unusable. A corrupt
 * `timestamp` (seconds are multiplied by 1000 by the caller) can overflow the Date range, and an
 * unguarded `toISOString()` would throw out of `parseLine` and abandon every remaining line
 * of the file. `MAX_EPOCH_MS` is the widest epoch a JS Date accepts.
 */
function isoFromEpochMs(ms: number): string {
    return ms <= 0 || ms > MAX_EPOCH_MS ? "" : new Date(ms).toISOString();
}

/** Split `inputTokens` into its uncached, cache-read and cache-write parts. */
function splitInput(input: number, cachedRead: number, cacheCreation: number): [number, number, number] {
    const read = Math.min(cachedRead, input);
    const remainder = input - read;
    const created = Math.min(cacheCreation, remainder);
    return [remainder - created, read, created];
}

export function createGrokUsageParser(options: CreateGrokParserOptions): DriverLineParser {
    // `||`, not `??`: an empty `currentModel` is "unknown", and `??` let "" through as a resolved
    // model, so every event of that turn was billed against a model named "".
    let sessionModel: string | undefined | null = options.currentModel || null;
    const fallbackSessionId = basename(dirname(options.file));
    return {
        parseLine(line: string, emit: (event: DriverUsageEvent) => void): void {
            const trimmed = line.trim();
            // Cheap prefilter before the JSON parse — most update lines are tool calls and hook
            // runs, not usage. ccusage does the same
            // (`LinePrefilter::all(&[b"\"turn_completed\""])`, parser.rs:215).
            if (!trimmed.includes('"turn_completed"')) {
                return;
            }
            let parsed: unknown;
            try {
                parsed = SafeJSON.parse(trimmed, { strict: true });
            } catch (err) {
                logger.debug({ err }, "ai-spend grok: skipping malformed update line");
                return;
            }
            if (!isRecord(parsed)) {
                return;
            }
            const raw = parsed as GrokLine;
            const update = raw.params?.update;
            if (update?.sessionUpdate !== "turn_completed" || !update.usage) {
                return;
            }
            const meta = raw.params?._meta;
            const agentMs = num(meta?.agentTimestampMs);
            // Grok writes Unix SECONDS on the envelope and milliseconds on `_meta`.
            const ms = agentMs > 0 ? agentMs : num(raw.timestamp) * 1000;
            const timestamp = isoFromEpochMs(ms);
            const sessionId = raw.params?.sessionId ?? fallbackSessionId;
            const usage = update.usage;
            const perModel = usage.modelUsage;
            let rows: [string, GrokModelUsage][];
            if (perModel && Object.keys(perModel).length > 0) {
                rows = Object.entries(perModel).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            } else {
                // Only ever needed when a turn omits `modelUsage`, so it stays lazy: the common
                // path never opens the sibling `summary.json`.
                if (sessionModel === null) {
                    sessionModel = options.resolveCurrentModel?.();
                }
                rows = [[sessionModel ?? "unknown", usage]];
            }
            // `costUsdTicks` normally appears on both the turn and each model row. When the turn
            // recorded a figure and the SOLE model row did not, the turn total IS that row's cost
            // — a sum over one term. With two or more rows the total cannot be attributed, so it
            // is left alone rather than guessed at.
            const turnTicks = num(usage.costUsdTicks);
            const soleRowTicks = rows.length === 1 && num(rows[0][1].costUsdTicks) === 0 ? turnTicks : 0;
            for (const [model, modelUsage] of rows) {
                const [inputTokens, cacheReadTokens, cacheCreationTokens] = splitInput(
                    num(modelUsage.inputTokens),
                    num(modelUsage.cachedReadTokens),
                    num(modelUsage.cacheCreationTokens)
                );
                const outputTokens = num(modelUsage.outputTokens);
                const reasoningTokens = num(modelUsage.reasoningTokens);
                if (
                    inputTokens === 0 &&
                    cacheReadTokens === 0 &&
                    cacheCreationTokens === 0 &&
                    outputTokens === 0 &&
                    reasoningTokens === 0
                ) {
                    continue;
                }
                const ticks = num(modelUsage.costUsdTicks) || soleRowTicks;
                const eventId = meta?.eventId;
                const event: DriverUsageEvent = {
                    id: eventId
                        ? `${eventId}|${model}`
                        : `${sessionId}|${ms}|${model}|${inputTokens}|${outputTokens}|${cacheReadTokens}|${cacheCreationTokens}|${reasoningTokens}`,
                    model,
                    timestamp,
                    inputTokens,
                    outputTokens,
                    cacheCreationTokens,
                    cacheReadTokens,
                };
                if (ticks > 0) {
                    event.recordedCostUsd = ticks / COST_USD_TICKS_PER_USD;
                }
                emit(event);
            }
        },
        snapshot(): unknown {
            return undefined;
        },
    };
}
