import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

type JsonRecord = Record<string, unknown>;

/**
 * Anthropic Messages request → xAI Responses request. Grok's native
 * `/v1/messages` shim merges parallel tool calls into one block and keeps only
 * the first name (raw wire capture 2026-08-21, nine request variants tried);
 * its `/responses` wire names every call. This translator is how the Anthropic
 * door reaches that reliable wire without losing reasoning continuity.
 *
 * Reasoning continuity: with `store: false` + `include:
 * ["reasoning.encrypted_content"]` grok returns reasoning items whose
 * `encrypted_content` it decrypts and consumes on replay (verified: a tampered
 * blob is rejected with a decrypt error, so replay is real, not tolerated).
 * The Anthropic wire has no slot for it, so it rides inside the thinking
 * block's `signature`, which Anthropic clients replay verbatim and never
 * inspect. Thinking blocks without a packed signature (another provider's
 * history, the shim's `signature: ""`) are dropped, exactly as the OpenAI
 * translation drops them.
 */

export const REASONING_SIGNATURE_PREFIX = "grokrs1:";

export function packReasoningSignature(id: string, encryptedContent: string): string {
    return `${REASONING_SIGNATURE_PREFIX}${id}:${encryptedContent}`;
}

export function unpackReasoningSignature(
    signature: unknown
): { id: string; encryptedContent: string } | undefined {
    if (typeof signature !== "string" || !signature.startsWith(REASONING_SIGNATURE_PREFIX)) {
        return undefined;
    }

    const rest = signature.slice(REASONING_SIGNATURE_PREFIX.length);
    const separator = rest.indexOf(":");

    if (separator <= 0 || separator === rest.length - 1) {
        return undefined;
    }

    return { id: rest.slice(0, separator), encryptedContent: rest.slice(separator + 1) };
}

function systemToInstructions(system: unknown): string | undefined {
    if (typeof system === "string" && system.length > 0) {
        return system;
    }

    if (!Array.isArray(system)) {
        return undefined;
    }

    const parts: string[] = [];

    for (const entry of system) {
        if (typeof entry === "string") {
            parts.push(entry);
        } else if (isObject(entry) && typeof entry.text === "string") {
            parts.push(entry.text);
        }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Same flattening the OpenAI translation applies to `tool_result.content`. */
function flattenToolResult(result: JsonRecord): string {
    const failedPrefix = result.is_error === true ? "[Tool call failed] " : "";
    const content = result.content;

    if (typeof content === "string") {
        return `${failedPrefix}${content}`;
    }

    if (!Array.isArray(content)) {
        return `${failedPrefix}${content === undefined ? "" : SafeJSON.stringify(content)}`;
    }

    const flattened = content
        .map((part) => {
            if (!isObject(part)) {
                return "";
            }

            if (part.type === "text") {
                return String(part.text ?? "");
            }

            if (part.type === "image" || (isObject(part.source) && part.source.type === "base64")) {
                return "[Image Omitted]";
            }

            return SafeJSON.stringify(part);
        })
        .join("\n");

    return `${failedPrefix}${flattened}`;
}

function userContentPart(part: JsonRecord): JsonRecord | null {
    if (part.type === "text" && typeof part.text === "string") {
        return { type: "input_text", text: part.text };
    }

    if (part.type === "image" && isObject(part.source)) {
        const source = part.source;

        if (source.type === "base64") {
            return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
        }

        if (source.type === "url" && typeof source.url === "string") {
            return { type: "input_image", image_url: source.url };
        }
    }

    if (part.type === "tool_use" || part.type === "thinking" || part.type === "redacted_thinking") {
        return null;
    }

    return { type: "input_text", text: SafeJSON.stringify(part) };
}

function pushUserMessage(input: JsonRecord[], parts: JsonRecord[]): void {
    if (parts.length > 0) {
        input.push({ role: "user", content: parts.splice(0) });
    }
}

function pushAssistantText(input: JsonRecord[], parts: string[]): void {
    if (parts.length > 0) {
        input.push({
            role: "assistant",
            content: [{ type: "output_text", text: parts.splice(0).join("\n") }],
        });
    }
}

function appendUserMessage(input: JsonRecord[], content: unknown): void {
    if (typeof content === "string") {
        if (content.length > 0) {
            input.push({ role: "user", content: [{ type: "input_text", text: content }] });
        }

        return;
    }

    if (!Array.isArray(content)) {
        return;
    }

    // Tool outputs become their own top-level items; everything else stays one
    // user message. Claude Code orders results before commentary, so emitting
    // the outputs first preserves the conversation order.
    const parts: JsonRecord[] = [];

    for (const part of content) {
        if (!isObject(part)) {
            continue;
        }

        if (part.type === "tool_result") {
            input.push({
                type: "function_call_output",
                call_id: part.tool_use_id,
                output: flattenToolResult(part),
            });
            continue;
        }

        const mapped = userContentPart(part);

        if (mapped !== null) {
            parts.push(mapped);
        }
    }

    pushUserMessage(input, parts);
}

function appendAssistantMessage(input: JsonRecord[], content: unknown, dropped: { thinking: number }): void {
    if (typeof content === "string") {
        if (content.length > 0) {
            input.push({ role: "assistant", content: [{ type: "output_text", text: content }] });
        }

        return;
    }

    if (!Array.isArray(content)) {
        return;
    }

    const textParts: string[] = [];

    for (const part of content) {
        if (!isObject(part)) {
            continue;
        }

        if (part.type === "thinking") {
            const packed = unpackReasoningSignature(part.signature);

            if (packed === undefined) {
                dropped.thinking += 1;
                continue;
            }

            pushAssistantText(input, textParts);
            input.push({
                type: "reasoning",
                id: packed.id,
                summary: [{ type: "summary_text", text: String(part.thinking ?? "") }],
                encrypted_content: packed.encryptedContent,
            });
            continue;
        }

        if (part.type === "tool_use") {
            pushAssistantText(input, textParts);
            input.push({
                type: "function_call",
                call_id: part.id,
                name: part.name,
                arguments: typeof part.input === "string" ? part.input : SafeJSON.stringify(part.input ?? {}),
            });
            continue;
        }

        if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text);
        }
    }

    pushAssistantText(input, textParts);
}

function responsesTools(tools: unknown): JsonRecord[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const mapped: JsonRecord[] = [];

    for (const tool of tools) {
        if (!isObject(tool) || typeof tool.name !== "string") {
            continue;
        }

        mapped.push({
            type: "function",
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.input_schema ?? { type: "object", properties: {}, required: [] },
        });
    }

    return mapped.length > 0 ? mapped : undefined;
}

function responsesToolChoice(choice: unknown): unknown {
    if (!isObject(choice)) {
        return undefined;
    }

    if (choice.type === "auto") {
        return "auto";
    }

    if (choice.type === "none") {
        return "none";
    }

    if (choice.type === "any") {
        return "required";
    }

    if (choice.type === "tool" && typeof choice.name === "string") {
        return { type: "function", name: choice.name };
    }

    return undefined;
}

/**
 * The decrypt-failure retry: a signature packed by a different conversation
 * (or truncated by a client) fails upstream decryption for the WHOLE request,
 * so the retry replays the same body minus every reasoning item.
 */
export function stripReasoningInput(body: JsonRecord): JsonRecord {
    if (!Array.isArray(body.input)) {
        return body;
    }

    return {
        ...body,
        input: body.input.filter((item) => !(isObject(item) && item.type === "reasoning")),
    };
}

export function anthropicToGrokResponses(body: JsonRecord, model: string): JsonRecord {
    const input: JsonRecord[] = [];
    const dropped = { thinking: 0 };

    if (Array.isArray(body.messages)) {
        for (const message of body.messages) {
            if (!isObject(message)) {
                continue;
            }

            if (message.role === "assistant") {
                appendAssistantMessage(input, message.content, dropped);
            } else {
                appendUserMessage(input, message.content);
            }
        }
    }

    if (dropped.thinking > 0) {
        logger.debug(
            { dropped: dropped.thinking, model },
            "ai-proxy: dropped thinking blocks without a grok reasoning signature"
        );
    }

    const out: JsonRecord = {
        model,
        input,
        store: false,
        include: ["reasoning.encrypted_content"],
    };

    const instructions = systemToInstructions(body.system);

    if (instructions !== undefined) {
        out.instructions = instructions;
    }

    const tools = responsesTools(body.tools);

    if (tools !== undefined) {
        out.tools = tools;
    }

    const toolChoice = responsesToolChoice(body.tool_choice);

    if (toolChoice !== undefined) {
        out.tool_choice = toolChoice;
    }

    if (isObject(body.tool_choice) && body.tool_choice.disable_parallel_tool_use === true) {
        out.parallel_tool_calls = false;
    }

    if (typeof body.max_tokens === "number") {
        out.max_output_tokens = body.max_tokens;
    }

    for (const field of ["stream", "temperature", "top_p", "reasoning_effort"] as const) {
        if (body[field] !== undefined) {
            out[field] = body[field];
        }
    }

    return out;
}
