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

/** The text of a `response_item` message: its `input_text` / `output_text` parts, in order. */
function contentText(content: unknown): string {
    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter(isRecord)
        .map((part) => asString(part.text))
        .filter((text) => text.length > 0)
        .join("\n");
}

/** A reasoning summary arrives as `summary[].text` or as `summary_text`, a string or a list. */
function reasoningText(value: unknown): string {
    if (Array.isArray(value)) {
        return value
            .map((entry) => (isRecord(entry) ? asString(entry.text) : asString(entry)))
            .filter((text) => text.length > 0)
            .join("\n");
    }

    return asString(value);
}

/**
 * Codex files its own context blocks (plugin lists, AGENTS.md, environment) as `user` messages.
 * Their metadata names what they carry; a real prompt is the one kind `user.text`, and a message
 * with no metadata at all comes from an older rollout that never injected context this way.
 */
function isTypedPrompt(payload: Record<string, unknown>): boolean {
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : undefined;
    const kinds = metadata?.content_item_kinds;

    return !Array.isArray(kinds) || kinds.includes("user.text");
}

/**
 * Native rollouts record the model's messages as `response_item` items with content parts, the
 * reasoning as `response_item/reasoning` (summary usually empty, the text lives in the
 * `item_completed` event) and the per-call tokens as `token_usage_record`; the streamed
 * `event_msg` user/agent messages below them exist only in older files.
 */
export function codexNativeLinesToTurns(lines: readonly (string | unknown)[]): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let assistant: TranscriptTurn | null = null;

    const flushAssistant = () => {
        if (assistant && (assistant.text || assistant.tools.length > 0 || assistant.usage || assistant.reasoning)) {
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

        if (type === "response_item" && payloadType === "message") {
            const role = asString(payload.role);
            const text = contentText(payload.content);

            if (role === "user") {
                flushAssistant();
                if (text && isTypedPrompt(payload)) {
                    turns.push({ id: `codex-user-${turns.length + 1}`, role: "user", at, text, tools: [] });
                }
            } else if (role === "assistant" && text) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.text += assistant.text ? `\n${text}` : text;
            }
            // `developer` and `system` messages are instructions, not conversation.
            continue;
        }
        if (type === "response_item" && payloadType === "reasoning") {
            const summary = reasoningText(payload.summary);
            if (summary) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.reasoning = assistant.reasoning ? `${assistant.reasoning}\n${summary}` : summary;
            }
            continue;
        }
        if (type === "event_msg" && payloadType === "item_completed") {
            const item = isRecord(payload.item) ? payload.item : {};
            const summary = asString(item.type) === "Reasoning" ? reasoningText(item.summary_text) : "";
            if (summary && !(assistant?.reasoning ?? "").includes(summary)) {
                assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
                assistant.reasoning = assistant.reasoning ? `${assistant.reasoning}\n${summary}` : summary;
            }
            continue;
        }
        if (type === "token_usage_record") {
            const usage = isRecord(payload.usage) ? payload.usage : {};
            const count = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
            assistant ??= { id: `codex-${turns.length + 1}`, role: "assistant", at, text: "", tools: [] };
            assistant.usage = {
                inputTokens: count(usage.input_tokens),
                cacheReadTokens: count(usage.cached_input_tokens),
                outputTokens: count(usage.output_tokens),
                reasoningTokens: count(usage.reasoning_output_tokens),
            };
            continue;
        }
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
