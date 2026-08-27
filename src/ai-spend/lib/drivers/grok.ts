import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripModelVariantSuffix } from "@genesiscz/utils/ai/catalog";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CreateParserOptions, DriverLineParser, DriverUsageEvent, MonitorDriver } from "./types";

/**
 * Grok CLI sessions: `~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl`
 * (`GROK_HOME` overrides the root). Only `updates.jsonl` carries usage —
 * `events.jsonl` and `chat_history.jsonl` are ignored, matching ccusage's
 * discovery (`rust/adapters/grok/src/paths.rs:32` `discover_session_files`).
 *
 * The usage line is a JSON-RPC notification:
 * `{"timestamp":…,"params":{"update":{"sessionUpdate":"turn_completed","usage":{…}}}}`,
 * with a per-model breakdown under `usage.modelUsage`.
 *
 * Token and cost semantics mirror `parse_session_files`
 * (`rust/adapters/grok/src/parser.rs:207-325`):
 *   - `cachedReadTokens` and `cacheCreationTokens` are SUBSETS of `inputTokens`,
 *     so billable input is `input - cachedRead - cacheCreation`
 *     (`split_input_tokens`, parser.rs:170).
 *   - `reasoningTokens` is a subset of `outputTokens` and is never billed twice.
 *   - `costUsdTicks` is fixed-point USD at 1e-10 per tick and is AUTHORITATIVE
 *     (parser.rs:140-153): Grok prices each API request separately and a
 *     `turn_completed` row only carries the per-turn sum, so recomputing from
 *     those totals cannot reproduce the figure Grok actually billed.
 *   - dedup is `eventId|model`, falling back to the token fingerprint.
 */

const COST_USD_TICKS_PER_USD = 1e10;

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

interface GrokUpdate {
    sessionUpdate?: string;
    usage?: GrokUsage;
}

interface GrokMeta {
    eventId?: string;
    agentTimestampMs?: number;
}

interface GrokLine {
    timestamp?: number;
    params?: {
        sessionId?: string;
        update?: GrokUpdate;
        _meta?: GrokMeta;
    };
}

function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Split `inputTokens` into its uncached, cache-read and cache-write parts. */
function splitInput(input: number, cachedRead: number, cacheCreation: number): [number, number, number] {
    const read = Math.min(cachedRead, input);
    const remainder = input - read;
    const created = Math.min(cacheCreation, remainder);

    return [remainder - created, read, created];
}

/** `summary.json` next to `updates.jsonl` names the session's model. */
function readSessionModel(file: string): string | undefined {
    const summary = join(dirname(file), "summary.json");

    if (!existsSync(summary)) {
        return undefined;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(summary, "utf8"), { strict: true });

        if (isRecord(parsed) && typeof parsed.current_model_id === "string") {
            return parsed.current_model_id;
        }
    } catch (err) {
        logger.debug({ err, summary }, "ai-spend grok: unreadable session summary");
    }

    return undefined;
}

/**
 * `grok-4.6-build` is the build-agent flavour of `grok-4.6`, so peel the
 * `-build` suffix as ccusage's `pricing_candidates` does
 * (`rust/adapters/grok/src/parser.rs:177`). The `xai/` and `x-ai/` prefixed
 * candidates ccusage also tries are skipped: this tool's pricing table is keyed
 * by bare catalog ids, so a prefixed key can never hit.
 */
function grokPriceCandidates(model: string): string[] {
    const candidates: string[] = [];
    const push = (value: string | null): void => {
        if (value && !candidates.includes(value)) {
            candidates.push(value);
        }
    };

    const stripped = model.startsWith("[grok] ") ? model.slice("[grok] ".length).trim() : model.trim();

    push(stripped);
    push(stripModelVariantSuffix(stripped));

    if (stripped.endsWith("-build")) {
        const base = stripped.slice(0, -"-build".length);
        push(base);
        push(stripModelVariantSuffix(base));
    }

    return candidates;
}

export const grokDriver: MonitorDriver = {
    id: "grok",

    roots(home: string): string[] {
        const override = env.grok.getHomeOverride();

        return [join(override ?? join(home, ".grok"), "sessions")];
    },

    isTranscript(name: string): boolean {
        return name === "updates.jsonl";
    },

    // sessions/<encoded-cwd>/<session-id>/updates.jsonl
    maxDepth: 3,

    createParser(options: CreateParserOptions): DriverLineParser {
        // Only ever needed when a turn omits `modelUsage`, so it stays lazy: the
        // common path never opens the sibling file.
        let sessionModel: string | undefined | null = null;
        const fallbackSessionId = basename(dirname(options.file));

        return {
            parseLine(line: string, emit: (event: DriverUsageEvent) => void): void {
                const trimmed = line.trim();

                // Cheap prefilter before the JSON parse — most update lines are
                // tool calls and hook runs, not usage. ccusage does the same
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
                const timestamp = ms > 0 ? new Date(ms).toISOString() : "";
                const sessionId = raw.params?.sessionId ?? fallbackSessionId;
                const usage = update.usage;
                const perModel = usage.modelUsage;
                let rows: [string, GrokModelUsage][];

                if (perModel && Object.keys(perModel).length > 0) {
                    rows = Object.entries(perModel).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
                } else {
                    if (sessionModel === null) {
                        sessionModel = readSessionModel(options.file);
                    }

                    rows = [[sessionModel ?? "unknown", usage]];
                }

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

                    const ticks = num(modelUsage.costUsdTicks);
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
    },

    priceCandidates: grokPriceCandidates,
};
