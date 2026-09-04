import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import { parseTranscriptLine } from "./parse-line";
import { clipResult, isoFromRecordTimestamp, type TranscriptTool, type TranscriptTurn } from "./types";

interface GrokUpdate {
    sessionUpdate?: string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: Record<string, unknown>;
    content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        return content.text;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => textFromContent(part))
            .filter(Boolean)
            .join("");
    }
    if (isRecord(content) && "content" in content) {
        return textFromContent(content.content);
    }
    return "";
}

function inputPreview(rawInput: Record<string, unknown> | undefined, fallback = ""): string {
    if (!rawInput) {
        return fallback;
    }
    const candidate = rawInput.command ?? rawInput.target_file ?? rawInput.file_path ?? rawInput.path;
    if (typeof candidate === "string" && candidate) {
        return candidate;
    }
    return SafeJSON.stringify(rawInput);
}

export function grokNativeLinesToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let current: TranscriptTurn | null = null;

    const flush = () => {
        if (current && (current.text || current.tools.length > 0)) {
            turns.push(current);
        }
        current = null;
    };

    for (const line of lines) {
        const parsed = parseTranscriptLine(line);
        if (!parsed) {
            continue;
        }
        const params = isRecord(parsed.params) ? parsed.params : {};
        const update = isRecord(params.update) ? (params.update as GrokUpdate) : {};
        const kind = update.sessionUpdate;
        const at = isoFromRecordTimestamp(parsed.timestamp);

        if (kind === "agent_message_chunk" || kind === "agent_message") {
            current ??= { id: `grok-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            current.text += textFromContent(update.content);
            continue;
        }
        if (kind === "user_message_chunk" || kind === "user_message") {
            flush();
            const text = textFromContent(update.content);
            if (text) {
                turns.push({ id: `grok-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
            }
            continue;
        }
        if (kind === "tool_call") {
            current ??= { id: `grok-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            current.tools.push({
                id: update.toolCallId ?? `tool-${current.tools.length}`,
                name: update.title ?? update.kind ?? "tool",
                inputPreview: inputPreview(update.rawInput),
                result: null,
                isError: false,
            });
            continue;
        }
        if (kind === "tool_call_update" && current) {
            const tool = current.tools.find((t) => t.id === update.toolCallId) ?? current.tools.at(-1);
            if (tool) {
                const result = textFromContent(update.content);
                if (result) {
                    tool.result = clipResult(result);
                }
                if (update.status === "failed") {
                    tool.isError = true;
                }
            }
            continue;
        }
        if (kind === "turn_completed") {
            flush();
        }
    }
    flush();
    return turns;
}

interface GrokWorkerLine {
    type?: string;
    data?: string;
    message?: string;
    toolName?: string;
    toolCallId?: string;
    status?: string | null;
    stopReason?: string;
    total_cost_usd?: number;
    usage?: Record<string, unknown>;
    rawInput?: Record<string, unknown>;
    rawOutput?: Record<string, unknown> | null;
    content?: unknown;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function workerToolOutput(line: GrokWorkerLine): string {
    const fromContent = textFromContent(line.content);
    if (fromContent) {
        return fromContent;
    }

    const forPrompt = line.rawOutput?.output_for_prompt;
    return typeof forPrompt === "string" ? forPrompt : "";
}

/**
 * One headless worker turn file (`tools grok run`, `--output-format streaming-json`)
 * as one transcript turn PER MODEL CALL. The stream is flat NDJSON, one delta
 * per line, and inside one model call the order is: `thought` deltas, `text`
 * deltas, one `usage` line, then that call's `tool_call` lines. Tool results
 * (`tool_call_update` completed/failed) land whenever the tool finishes, often
 * after the next model call has started, so they attach by `toolCallId` across
 * turns. A model call that died before its `usage` line is still emitted, so a
 * turn that ended on an error shows what it was doing. `end` and `error` become
 * a trailing `system` turn carrying the event.
 */
export function grokWorkerTextToTurns(text: string, sessionId: string, turnIndex = 1): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    const toolsById = new Map<string, TranscriptTool>();
    const prefix = `${sessionId}-turn-${turnIndex}`;
    let open: TranscriptTurn | null = null;
    // After the usage line the call is in its tool phase; the next delta opens a new call.
    let afterUsage = false;

    const flush = () => {
        if (open && (open.text || open.reasoning || open.tools.length > 0 || open.usage)) {
            turns.push(open);
        }

        open = null;
        afterUsage = false;
    };

    const ensureOpen = (): TranscriptTurn => {
        if (open === null) {
            const step = turns.filter((turn) => turn.role === "assistant").length + 1;
            open = { id: `${prefix}-step-${step}`, role: "assistant", at: null, text: "", tools: [], step };
        }

        return open;
    };

    for (const rawLine of text.split("\n")) {
        const parsed = parseTranscriptLine(rawLine);
        if (!parsed) {
            continue;
        }

        const line = parsed as GrokWorkerLine;
        switch (line.type) {
            case "thought":
            case "text": {
                if (typeof line.data !== "string") {
                    break;
                }

                if (afterUsage) {
                    flush();
                }

                const turn = ensureOpen();
                if (line.type === "text") {
                    turn.text += line.data;
                } else {
                    turn.reasoning = (turn.reasoning ?? "") + line.data;
                }

                break;
            }
            case "usage": {
                const usage = line.usage ?? {};
                const turn = ensureOpen();
                turn.usage = {
                    inputTokens: num(usage.input_tokens),
                    cacheReadTokens: num(usage.cache_read_input_tokens),
                    outputTokens: num(usage.output_tokens),
                    reasoningTokens: num(usage.reasoning_tokens),
                };
                afterUsage = true;
                break;
            }
            case "tool_call": {
                const turn = ensureOpen();
                const tool: TranscriptTool = {
                    id: line.toolCallId ?? `${prefix}-tool-${toolsById.size}`,
                    name: line.toolName ?? "tool",
                    inputPreview: inputPreview(line.rawInput),
                    result: null,
                    isError: false,
                };
                turn.tools.push(tool);
                toolsById.set(tool.id, tool);
                break;
            }
            case "tool_call_update": {
                if (line.status !== "completed" && line.status !== "failed") {
                    break;
                }

                const tool = line.toolCallId ? toolsById.get(line.toolCallId) : undefined;
                if (!tool) {
                    break;
                }

                const output = stripAnsi(workerToolOutput(line));
                tool.result = output ? clipResult(output) : null;
                tool.resultChars = output.length;
                tool.isError = line.status === "failed";
                const exitCode = num(line.rawOutput?.exit_code);
                if (exitCode !== undefined) {
                    tool.exitCode = exitCode;
                }

                break;
            }
            case "end": {
                flush();
                const stopReason = line.stopReason ?? "unknown";
                turns.push({
                    id: `${prefix}-end`,
                    role: "system",
                    at: null,
                    text: `end (${stopReason})`,
                    tools: [],
                    event: { kind: "end", stopReason, costUsd: line.total_cost_usd },
                });
                break;
            }
            case "error": {
                flush();
                const message = line.message ?? line.data ?? "unknown grok error";
                turns.push({
                    id: `${prefix}-error`,
                    role: "system",
                    at: null,
                    text: message,
                    tools: [],
                    event: { kind: "error", message },
                });
                break;
            }
            default:
                break;
        }
    }

    flush();
    return turns;
}
