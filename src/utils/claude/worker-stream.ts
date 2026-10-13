import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { WorkerUsagePart } from "@genesiscz/utils/worker/cost";
import type { WorkerEvent, WorkerUsage } from "@genesiscz/utils/worker/events";

const log = logger.child({ component: "claude:worker:stream" });

interface ContentBlock {
    type?: string;
    text?: string;
    thinking?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
}

interface ClaudeStreamLine {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: ContentBlock[] };
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    num_turns?: number;
    usage?: Record<string, unknown>;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function usageOf(line: ClaudeStreamLine): WorkerUsage | undefined {
    if (!line.usage && line.total_cost_usd === undefined) {
        return undefined;
    }

    return {
        inputTokens: num(line.usage?.input_tokens),
        outputTokens: num(line.usage?.output_tokens),
        cacheReadTokens: num(line.usage?.cache_read_input_tokens),
        totalCostUsd: line.total_cost_usd,
    };
}

function toolTarget(input: Record<string, unknown> | undefined): string | undefined {
    const candidate = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.url;
    return typeof candidate === "string" ? candidate : undefined;
}

/** The text of a tool_result block: a string, or the text parts of a content array. */
function toolOutput(content: unknown): string | undefined {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        const text = content
            .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
            .join("");
        return text || undefined;
    }

    return undefined;
}

/**
 * Map one `claude -p --output-format stream-json` line onto the shared worker
 * vocabulary. Verified against a live capture 2026-09-01: top-level types are
 * system (subtypes init | status | hook_started | hook_response |
 * thinking_tokens), assistant, user, rate_limit_event, result — and every line
 * carries the `--session-id` uuid back as `session_id`.
 *
 * One input line can carry several content blocks, so this returns an array.
 * Hook chatter, status and rate-limit lines are deliberately outside the
 * shared stream; unknown types are logged at debug, never silently dropped.
 */
export function toWorkerEvents(rawLine: string, fallbackSessionId: string): WorkerEvent[] {
    let line: ClaudeStreamLine;
    try {
        const parsed = SafeJSON.parse(rawLine, { strict: true });
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return [];
        }

        line = parsed as ClaudeStreamLine;
    } catch (err) {
        log.debug({ err, rawLine: rawLine.slice(0, 200) }, "unparseable claude stream line");
        return [];
    }

    const sessionId = line.session_id ?? fallbackSessionId;

    switch (line.type) {
        case "system":
            if (line.subtype === "init") {
                return [{ kind: "turn.started", sessionId }];
            }

            return [];
        case "assistant":
        case "user": {
            const events: WorkerEvent[] = [];
            for (const block of line.message?.content ?? []) {
                switch (block.type) {
                    case "text":
                        events.push({ kind: "text", sessionId, text: block.text ?? "", delta: false });
                        break;
                    case "thinking":
                        events.push({ kind: "reasoning", sessionId, text: block.thinking ?? "", delta: false });
                        break;
                    case "tool_use":
                        events.push({
                            kind: "tool_call",
                            sessionId,
                            tool: block.name ?? "?",
                            target: toolTarget(block.input),
                            callId: block.id,
                        });
                        break;
                    case "tool_result":
                        events.push({
                            kind: "tool_result",
                            sessionId,
                            callId: block.tool_use_id,
                            output: toolOutput(block.content),
                            ok: block.is_error !== true,
                        });
                        break;
                    default:
                        log.debug({ blockType: block.type }, "unmapped claude content block type");
                }
            }

            return events;
        }
        case "result":
            if (line.is_error || line.subtype?.startsWith("error")) {
                return [{ kind: "turn.failed", sessionId, reason: line.subtype ?? line.result }];
            }

            return [{ kind: "turn.completed", sessionId, turn: line.num_turns, usage: usageOf(line) }];
        case "rate_limit_event":
            return [];
        default:
            log.debug({ type: line.type }, "unmapped claude stream line type");
            return [];
    }
}

/** All shared events for one finished turn transcript. */
export function parseTurnEvents(text: string, sessionId: string): WorkerEvent[] {
    const events: WorkerEvent[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        events.push(...toWorkerEvents(line, sessionId));
    }

    return events;
}

export interface ClaudeTurnUsage {
    /** One part per model the turn used; null when the turn wrote no `result` line with usage. */
    parts: WorkerUsagePart[] | null;
    /** The `result` line's `total_cost_usd`: Claude Code's own figure for this invocation. */
    reportedUsd?: number;
    /** The model the turn mostly ran on: the `modelUsage` entry with the most output. */
    model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What one finished `claude -p` turn used, for the cost ledger. The `result` line is per
 * invocation (a resumed turn reports its own tokens, not the session's), and its `modelUsage`
 * splits them by model: Claude Code runs side calls on a smaller model, so pricing the whole
 * turn at the main model would be wrong. Anthropic's `input_tokens` already excludes cache
 * reads and writes.
 */
export function claudeTurnUsage(text: string): ClaudeTurnUsage {
    let result: Record<string, unknown> | null = null;

    for (const line of text.split("\n")) {
        if (!line.includes('"type":"result"')) {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(line, { strict: true });

            if (isRecord(parsed) && parsed.type === "result") {
                result = parsed;
            }
        } catch (err) {
            log.debug({ err, line: line.slice(0, 200) }, "skipping malformed claude result line");
        }
    }

    if (!result) {
        return { parts: null };
    }

    const reportedUsd = num(result.total_cost_usd);
    const modelUsage = isRecord(result.modelUsage) ? result.modelUsage : {};
    const parts: WorkerUsagePart[] = [];

    for (const [key, value] of Object.entries(modelUsage)) {
        if (!isRecord(value)) {
            continue;
        }

        parts.push({
            model: typeof value.canonicalModel === "string" ? value.canonicalModel : key,
            tokens: {
                input: num(value.inputTokens) ?? 0,
                cacheRead: num(value.cacheReadInputTokens) ?? 0,
                cacheWrite: num(value.cacheCreationInputTokens) ?? 0,
                output: num(value.outputTokens) ?? 0,
                reasoning: num(value.thinkingTokens) ?? 0,
            },
        });
    }

    const usage = isRecord(result.usage) ? result.usage : null;

    if (parts.length === 0 && usage) {
        parts.push({
            model: null,
            tokens: {
                input: num(usage.input_tokens) ?? 0,
                cacheRead: num(usage.cache_read_input_tokens) ?? 0,
                cacheWrite: num(usage.cache_creation_input_tokens) ?? 0,
                output: num(usage.output_tokens) ?? 0,
                reasoning: 0,
            },
        });
    }

    const main = [...parts].sort((a, b) => b.tokens.output - a.tokens.output)[0]?.model ?? undefined;

    return {
        parts: parts.length > 0 ? parts : null,
        ...(reportedUsd === undefined ? {} : { reportedUsd }),
        ...(main ? { model: main } : {}),
    };
}
