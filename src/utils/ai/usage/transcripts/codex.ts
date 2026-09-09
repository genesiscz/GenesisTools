import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type CodexContext, updateCodexContext } from "./codex-context";
import { isRecord, num } from "./parse-helpers";
import type { CreateParserOptions, DriverLineParser, DriverUsageEvent } from "./types";

interface CodexRawUsage {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
}
interface CodexInfo {
    model?: string;
    last_token_usage?: CodexRawUsage;
    total_token_usage?: CodexRawUsage;
}
interface CodexPayload {
    type?: string;
    model?: string;
    info?: CodexInfo;
}
interface CodexLine {
    type?: string;
    timestamp?: string;
    payload?: CodexPayload;
}
interface CodexState {
    model?: string;
    totals?: CodexRawUsage;
    serviceTier?: string;
    context?: CodexContext;
}

/** First candidate that is genuinely a non-empty string. */
function firstString(...candidates: (string | undefined)[]): string | undefined {
    return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function readState(state: unknown): CodexState {
    if (!isRecord(state)) {
        return {};
    }
    return {
        model: typeof state.model === "string" ? state.model : undefined,
        totals: isRecord(state.totals) ? (state.totals as CodexRawUsage) : undefined,
        serviceTier: typeof state.serviceTier === "string" ? state.serviceTier : undefined,
        context: isRecord(state.context) ? (state.context as CodexContext) : {},
    };
}

function sameTotals(a: CodexRawUsage | undefined, b: CodexRawUsage | undefined): boolean {
    return Boolean(
        a &&
            b &&
            num(a.input_tokens) === num(b.input_tokens) &&
            num(a.cached_input_tokens) === num(b.cached_input_tokens) &&
            num(a.cache_write_input_tokens) === num(b.cache_write_input_tokens) &&
            num(a.output_tokens) === num(b.output_tokens) &&
            num(a.reasoning_output_tokens) === num(b.reasoning_output_tokens) &&
            num(a.total_tokens) === num(b.total_tokens)
    );
}

function subtractTotals(current: CodexRawUsage, previous: CodexRawUsage | undefined): CodexRawUsage {
    if (
        previous &&
        (num(current.input_tokens) < num(previous.input_tokens) ||
            num(current.output_tokens) < num(previous.output_tokens))
    ) {
        return current;
    }
    const sub = (a: number | undefined, b: number | undefined): number => Math.max(0, num(a) - num(b));
    return {
        input_tokens: sub(current.input_tokens, previous?.input_tokens),
        cached_input_tokens: sub(current.cached_input_tokens, previous?.cached_input_tokens),
        cache_write_input_tokens: sub(current.cache_write_input_tokens, previous?.cache_write_input_tokens),
        output_tokens: sub(current.output_tokens, previous?.output_tokens),
        reasoning_output_tokens: sub(current.reasoning_output_tokens, previous?.reasoning_output_tokens),
        total_tokens: sub(current.total_tokens, previous?.total_tokens),
    };
}

export function createCodexUsageParser(options: CreateParserOptions): DriverLineParser {
    const state = readState(options.state);
    const context = state.context ?? {};
    state.context = context;
    return {
        parseLine(line: string, emit: (event: DriverUsageEvent) => void): void {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            let parsed: unknown;
            try {
                parsed = SafeJSON.parse(trimmed, { strict: true });
            } catch (err) {
                logger.debug({ err }, "ai-spend codex: skipping malformed rollout line");
                return;
            }
            if (!isRecord(parsed)) {
                return;
            }
            const raw = parsed as CodexLine;
            const payload = isRecord(parsed.payload) ? parsed.payload : {};
            updateCodexContext(context, raw.type, payload, typeof raw.timestamp === "string" ? raw.timestamp : "");
            if (
                raw.type === "event_msg" &&
                payload.type === "thread_settings_applied" &&
                isRecord(payload.thread_settings)
            ) {
                const settings = payload.thread_settings;
                if (Object.hasOwn(settings, "service_tier")) {
                    state.serviceTier = typeof settings.service_tier === "string" ? settings.service_tier : undefined;
                }
                if (typeof settings.model === "string" && settings.model.length > 0) {
                    state.model = settings.model;
                }
                return;
            }
            if (raw.type === "turn_context") {
                if (Object.hasOwn(payload, "service_tier")) {
                    state.serviceTier = typeof payload.service_tier === "string" ? payload.service_tier : undefined;
                }
                const model = raw.payload?.model;
                if (typeof model === "string" && model.length > 0) {
                    state.model = model;
                }
                return;
            }
            if (raw.type !== "event_msg" || raw.payload?.type !== "token_count") {
                return;
            }
            const info = raw.payload.info;
            const totals = info?.total_token_usage;
            // Codex re-emits the same cumulative total on some events; when it has NOT advanced,
            // `last_token_usage` is a repeat of a turn that was already counted.
            const advanced = !totals || !sameTotals(totals, state.totals);
            const last = advanced ? info?.last_token_usage : undefined;
            const usage = last ?? (totals ? subtractTotals(totals, state.totals) : undefined);
            if (totals) {
                state.totals = totals;
            }
            if (!usage) {
                return;
            }
            const inputTotal = num(usage.input_tokens);
            const cached = Math.min(num(usage.cached_input_tokens), inputTotal);
            const output = num(usage.output_tokens);
            const reasoning = num(usage.reasoning_output_tokens);
            if (inputTotal === 0 && cached === 0 && output === 0 && reasoning === 0) {
                return;
            }
            const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
            // The cast to CodexLine is a shape hint, not a validation: these files are a system
            // boundary. A non-string `model` would reach `priceCandidates()` and throw on
            // `.endsWith`, aborting the chunk.
            const model = firstString(raw.payload.model, info?.model, state.model) ?? "unknown";
            const cacheWrite = Math.min(num(usage.cache_write_input_tokens), inputTotal - cached);
            const inputTokens = inputTotal - cached - cacheWrite;
            emit({
                id: `${timestamp}|${model}|${inputTokens}|${cached}|${output}|${reasoning}`,
                model,
                timestamp,
                inputTokens,
                outputTokens: output,
                cacheCreationTokens: cacheWrite,
                serviceTier: state.serviceTier,
                codex: { ...state.context },
                cacheReadTokens: cached,
                reasoningOutputTokens: reasoning,
            });
        },
        snapshot(): unknown {
            return state;
        },
    };
}
