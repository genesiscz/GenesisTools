import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { WorkerTokens, WorkerUsagePart } from "@genesiscz/utils/worker/cost";
import type { WorkerEvent, WorkerUsage } from "@genesiscz/utils/worker/events";

const log = logger.child({ component: "grok:stream" });

export interface GrokToolCall {
    tool: string;
    target: string;
}

export interface GrokTurnSummary {
    report: string;
    toolCalls: GrokToolCall[];
    ended: boolean;
    sessionId?: string;
    malformedLines: number;
}

interface GrokStreamEvent {
    type?: string;
    data?: string;
    toolName?: string;
    toolCallId?: string;
    status?: string | null;
    stopReason?: string;
    sessionId?: string;
    usage?: Record<string, unknown>;
    total_cost_usd?: number;
    rawInput?: Record<string, unknown>;
}

function toolTarget(rawInput: Record<string, unknown> | undefined): string {
    const candidate = rawInput?.command ?? rawInput?.target_file ?? rawInput?.file_path ?? "";
    return typeof candidate === "string" ? candidate : SafeJSON.stringify(candidate);
}

/**
 * The grok CLI's `--output-format streaming-json` stream is flat NDJSON
 * ({"type":"text","data":...}), not the ACP-nested shape its help implies.
 */
export function parseTurnLog(text: string): GrokTurnSummary {
    const summary: GrokTurnSummary = { report: "", toolCalls: [], ended: false, malformedLines: 0 };

    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        let event: GrokStreamEvent;
        try {
            const parsed = SafeJSON.parse(line, { strict: true });
            // `null`, a bare number and an array are all valid JSON. Casting them
            // to GrokStreamEvent and reading .type throws OUTSIDE this catch, so
            // the whole turn died before its metadata was written and the next
            // steer reused the same turn number.
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                summary.malformedLines += 1;
                log.debug({ line: line.slice(0, 200) }, "skipping non-object grok stream line");
                continue;
            }

            event = parsed as GrokStreamEvent;
        } catch (err) {
            summary.malformedLines += 1;
            log.debug({ err, line: line.slice(0, 200) }, "skipping malformed grok stream line");
            continue;
        }

        if (event.type === "text" && typeof event.data === "string") {
            summary.report += event.data;
        } else if (event.type === "tool_call") {
            summary.toolCalls.push({ tool: event.toolName ?? "?", target: toolTarget(event.rawInput) });
        } else if (event.type === "end") {
            summary.ended = true;
            if (typeof event.sessionId === "string" && event.sessionId.trim()) {
                summary.sessionId = event.sessionId;
            }
        }
    }

    return summary;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function usageOf(event: GrokStreamEvent): WorkerUsage | undefined {
    if (!event.usage && event.total_cost_usd === undefined) {
        return undefined;
    }

    return {
        inputTokens: num(event.usage?.input_tokens),
        outputTokens: num(event.usage?.output_tokens),
        cacheReadTokens: num(event.usage?.cache_read_input_tokens),
        reasoningTokens: num(event.usage?.reasoning_tokens),
        totalCostUsd: event.total_cost_usd ?? num((event as Record<string, unknown>).total_cost_usd),
    };
}

/**
 * Map one flat grok NDJSON line onto the shared worker vocabulary.
 *
 * `available_commands`, `usage`, `plan` and in-progress `tool_call_update`
 * lines are deliberately outside the shared stream; unknown types are also
 * null but logged at debug so a CLI addition never disappears silently.
 */
export function toWorkerEvent(line: string, sessionId: string): WorkerEvent | null {
    let event: GrokStreamEvent;
    try {
        const parsed = SafeJSON.parse(line, { strict: true });
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }

        event = parsed as GrokStreamEvent;
    } catch (err) {
        log.debug({ err, rawLine: line.slice(0, 200) }, "unparseable grok stream line");
        return null;
    }

    switch (event.type) {
        case "text":
            return { kind: "text", sessionId, text: event.data ?? "", delta: true };
        case "thought":
            return { kind: "reasoning", sessionId, text: event.data ?? "", delta: true };
        case "tool_call":
            return {
                kind: "tool_call",
                sessionId,
                tool: event.toolName ?? "?",
                target: toolTarget(event.rawInput),
                callId: event.toolCallId,
            };
        case "tool_call_update":
            if (event.status === "completed" || event.status === "failed") {
                return {
                    kind: "tool_result",
                    sessionId,
                    callId: event.toolCallId,
                    ok: event.status === "completed",
                };
            }

            return null;
        case "end":
            return { kind: "turn.completed", sessionId: event.sessionId ?? sessionId, usage: usageOf(event) };
        case "error":
            return { kind: "error", sessionId, message: event.data ?? "unknown grok error" };
        case "available_commands":
        case "usage":
        case "plan":
            return null;
        default:
            log.debug({ type: event.type }, "unmapped grok stream event type");
            return null;
    }
}

export interface GrokTurnUsage {
    /** One part per model call when the stream carried `usage` lines; null when it reported no usage at all. */
    parts: WorkerUsagePart[] | null;
    /** The `end` event's `total_cost_usd`: grok's own figure for the turn. */
    reportedUsd?: number;
    /** The model the `end` event names, when it names exactly one. */
    model?: string;
}

function grokTokens(usage: Record<string, unknown> | undefined): WorkerTokens {
    // grok's `input_tokens` already EXCLUDES cache reads: the `end` event's total_tokens is
    // input + cache_read + output (5,624,671 = 323,748 + 5,248,256 + 52,667 on 2026-10-13).
    return {
        input: num(usage?.input_tokens) ?? 0,
        cacheRead: num(usage?.cache_read_input_tokens) ?? 0,
        cacheWrite: num(usage?.cache_creation_input_tokens) ?? 0,
        output: num(usage?.output_tokens) ?? 0,
        reasoning: num(usage?.reasoning_tokens) ?? 0,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What one finished turn used, for the cost ledger. Each `usage` line is one model call, so the
 * parts keep their own prompt length and a context band applies per call; the `end` event holds
 * the totals, the model and grok's own cost figure.
 */
export function grokTurnUsage(text: string): GrokTurnUsage {
    const calls: WorkerUsagePart[] = [];
    let end: Record<string, unknown> | null = null;

    for (const line of text.split("\n")) {
        if (!line.includes('"usage"')) {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(line, { strict: true });
        } catch (err) {
            log.debug({ err, line: line.slice(0, 200) }, "skipping malformed grok usage line");
            continue;
        }

        if (!isRecord(parsed)) {
            continue;
        }

        if (parsed.type === "usage" && isRecord(parsed.usage)) {
            calls.push({ model: null, tokens: grokTokens(parsed.usage), singleRequest: true });
        } else if (parsed.type === "end") {
            end = parsed;
        }
    }

    const modelUsage = isRecord(end?.modelUsage) ? end.modelUsage : {};
    const models = Object.keys(modelUsage);
    const model = models.length === 1 ? models[0] : undefined;
    const reportedUsd = num(end?.total_cost_usd);
    const result = (parts: WorkerUsagePart[] | null): GrokTurnUsage => ({
        parts,
        ...(reportedUsd === undefined ? {} : { reportedUsd }),
        ...(model ? { model } : {}),
    });

    // Several models in one turn: the per-call lines do not say which served them, so the
    // per-model totals are the only honest split.
    if (models.length > 1) {
        return result(
            models.map((name) => {
                const entry = isRecord(modelUsage[name]) ? modelUsage[name] : {};

                return {
                    model: name,
                    tokens: {
                        input: num(entry.inputTokens) ?? 0,
                        cacheRead: num(entry.cacheReadInputTokens) ?? 0,
                        cacheWrite: num(entry.cacheCreationInputTokens) ?? 0,
                        output: num(entry.outputTokens) ?? 0,
                        reasoning: 0,
                    },
                };
            })
        );
    }

    if (calls.length > 0) {
        return result(calls.map((call) => ({ ...call, model: model ?? null })));
    }

    if (end && isRecord(end.usage)) {
        return result([{ model: model ?? null, tokens: grokTokens(end.usage) }]);
    }

    return result(null);
}

/** All shared events for one finished turn transcript. */
export function parseTurnEvents(text: string, sessionId: string): WorkerEvent[] {
    const events: WorkerEvent[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        const event = toWorkerEvent(line, sessionId);
        if (event) {
            events.push(event);
        }
    }

    return events;
}
