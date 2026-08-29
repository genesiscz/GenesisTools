import { parseTurnLog } from "@genesiscz/utils/grok/stream";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseTranscriptLine } from "./parse-line";
import { clipResult, isoFromRecordTimestamp, type TranscriptTurn } from "./types";

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

export function grokWorkerTextToTurns(text: string, sessionId: string, turnIndex = 1): TranscriptTurn[] {
    const summary = parseTurnLog(text);
    if (!summary.report && summary.toolCalls.length === 0) {
        return [];
    }
    return [
        {
            id: `${sessionId}-turn-${turnIndex}`,
            role: "assistant",
            at: null,
            text: summary.report,
            tools: summary.toolCalls.map((call, index) => ({
                id: `${sessionId}-turn-${turnIndex}-tool-${index}`,
                name: call.tool,
                inputPreview: call.target,
                result: null,
                isError: false,
            })),
        },
    ];
}
