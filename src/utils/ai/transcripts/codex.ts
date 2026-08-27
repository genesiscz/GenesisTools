import { parseTranscriptLine } from "./parse-line";
import { clipResult, type TranscriptTurn } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export function codexGtEventsToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let assistant: TranscriptTurn | null = null;

    const flushAssistant = () => {
        if (assistant && (assistant.text || assistant.tools.length > 0)) {
            turns.push(assistant);
        }
        assistant = null;
    };

    for (const line of lines) {
        const parsed = parseTranscriptLine(line);
        if (!parsed) {
            continue;
        }
        const method = asString(parsed.method);
        const params = isRecord(parsed.params) ? parsed.params : {};
        const at = asString(parsed.ts) || null;

        if (method.includes("agentMessage")) {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.text += asString(params.delta) || asString(params.text) || asString(params.message);
            continue;
        }
        if (method.includes("userMessage") || method.includes("user/message")) {
            flushAssistant();
            const text = asString(params.text) || asString(params.message) || asString(params.body);
            if (text) {
                turns.push({ id: `codex-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
            }
            continue;
        }
        if (method.includes("commandExecution") || method.includes("tool")) {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            const name = method.includes("commandExecution") ? "commandExecution" : method.split("/").at(-1) || "tool";
            assistant.tools.push({
                id: asString(params.id) || `codex-tool-${assistant.tools.length}`,
                name,
                inputPreview: asString(params.command) || asString(params.input) || "",
                result: clipResult(asString(params.output) || asString(params.result) || "") || null,
                isError: params.failed === true,
            });
        }
    }
    flushAssistant();
    return turns;
}

function previewFromArguments(raw: string): string {
    if (!raw) {
        return "";
    }
    const parsed = parseTranscriptLine(raw);
    if (parsed) {
        const candidate = parsed.command ?? parsed.cmd ?? parsed.path ?? parsed.file_path ?? parsed.target_file;
        if (typeof candidate === "string" && candidate) {
            return candidate;
        }
    }
    return raw;
}

export function codexNativeLinesToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let assistant: TranscriptTurn | null = null;

    const flushAssistant = () => {
        if (assistant && (assistant.text || assistant.tools.length > 0)) {
            turns.push(assistant);
        }
        assistant = null;
    };

    for (const line of lines) {
        const parsed = parseTranscriptLine(line);
        if (!parsed) {
            continue;
        }
        const type = asString(parsed.type);
        const payload = isRecord(parsed.payload) ? parsed.payload : {};
        const at = asString(parsed.timestamp) || null;
        const payloadType = asString(payload.type);

        if (type === "event_msg" && (payloadType === "user_message" || payloadType === "user_message_delta")) {
            flushAssistant();
            const text = asString(payload.message) || asString(payload.text);
            if (text) {
                turns.push({ id: `codex-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
            }
            continue;
        }
        if (type === "event_msg" && (payloadType === "agent_message" || payloadType === "agent_message_delta")) {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.text += asString(payload.message) || asString(payload.text);
            continue;
        }
        if (type === "response_item" && payloadType === "function_call") {
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.tools.push({
                id: asString(payload.call_id) || `codex-tool-${assistant.tools.length}`,
                name: asString(payload.name) || "tool",
                inputPreview: previewFromArguments(asString(payload.arguments)),
                result: null,
                isError: false,
            });
            continue;
        }
        if (type === "response_item" && payloadType === "function_call_output" && assistant) {
            const tool = assistant.tools.find((t) => t.id === asString(payload.call_id)) ?? assistant.tools.at(-1);
            if (tool) {
                const result = asString(payload.output) || asString(payload.result);
                if (result) {
                    tool.result = clipResult(result);
                }
            }
        }
    }
    flushAssistant();
    return turns;
}
