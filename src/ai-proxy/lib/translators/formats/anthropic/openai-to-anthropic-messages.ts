import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

/**
 * Maps an OpenAI chat-completions request body into an Anthropic
 * `/v1/messages` request body. The proxy speaks OpenAI to its clients but the
 * Claude subscription upstream expects the Anthropic Messages shape.
 *
 * Handles: system extraction (Anthropic keeps system top-level), role mapping,
 * multi-part text/image content, assistant tool_calls → tool_use, tool-role
 * messages → user tool_result, tool/tool_choice translation, sampling params,
 * and coalescing of adjacent same-role turns (Anthropic requires strict
 * alternation and rejects consecutive same-role messages).
 */

const DEFAULT_MAX_TOKENS = 4096;

export interface OpenAiChatBody {
    model?: string;
    messages?: unknown;
    max_tokens?: number;
    max_completion_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    stream?: boolean;
    tools?: unknown;
    tool_choice?: unknown;
    [key: string]: unknown;
}

export interface AnthropicTextBlock {
    type: "text";
    text: string;
}

export interface AnthropicImageBlock {
    type: "image";
    source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
}

export interface AnthropicToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | AnthropicTextBlock[];
}

export type AnthropicContentBlock =
    | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicToolUseBlock
    | AnthropicToolResultBlock;

export interface AnthropicMessage {
    role: "user" | "assistant";
    content: AnthropicContentBlock[];
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: unknown;
}

export type AnthropicToolChoice =
    | { type: "auto" }
    | { type: "any" }
    | { type: "tool"; name: string };

export interface AnthropicMessagesBody {
    model: string;
    max_tokens: number;
    system?: string;
    messages: AnthropicMessage[];
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
    stream?: boolean;
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
}

export interface OpenAiToAnthropicOptions {
    /** Concrete Anthropic model id to forward (e.g. claude-haiku-4-5-20251001). */
    model: string;
    /** max_tokens fallback when the request omits it (Anthropic requires it). */
    maxTokensDefault?: number;
}

function textBlock(text: string): AnthropicTextBlock {
    return { type: "text", text };
}

function imageBlockFromUrl(url: string): AnthropicImageBlock {
    const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(url);

    if (dataUrl) {
        return {
            type: "image",
            source: { type: "base64", media_type: dataUrl[1] ?? "image/png", data: dataUrl[2] ?? "" },
        };
    }

    return { type: "image", source: { type: "url", url } };
}

function contentToBlocks(content: unknown): AnthropicContentBlock[] {
    if (typeof content === "string") {
        return content.length > 0 ? [textBlock(content)] : [];
    }

    if (!Array.isArray(content)) {
        return content == null ? [] : [textBlock(String(content))];
    }

    const blocks: AnthropicContentBlock[] = [];

    for (const part of content) {
        if (!isObject(part)) {
            continue;
        }

        if (part.type === "text" && typeof part.text === "string") {
            blocks.push(textBlock(part.text));
            continue;
        }

        if (part.type === "image_url" && isObject(part.image_url) && typeof part.image_url.url === "string") {
            blocks.push(imageBlockFromUrl(part.image_url.url));
            continue;
        }
    }

    return blocks;
}

function toolUseBlocksFromToolCalls(toolCalls: unknown): AnthropicToolUseBlock[] {
    if (!Array.isArray(toolCalls)) {
        return [];
    }

    const blocks: AnthropicToolUseBlock[] = [];

    for (const call of toolCalls) {
        if (!isObject(call)) {
            continue;
        }

        const fn = isObject(call.function) ? call.function : {};
        const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
        let input: unknown = {};

        if (rawArgs.length > 0) {
            try {
                input = SafeJSON.parse(rawArgs);
            } catch {
                input = { _raw: rawArgs };
            }
        }

        blocks.push({
            type: "tool_use",
            id: typeof call.id === "string" ? call.id : `call_${crypto.randomUUID()}`,
            name: typeof fn.name === "string" ? fn.name : "unknown",
            input,
        });
    }

    return blocks;
}

function toolResultContent(content: unknown): string | AnthropicTextBlock[] {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        const parts: AnthropicTextBlock[] = [];

        for (const part of content) {
            if (isObject(part) && part.type === "text" && typeof part.text === "string") {
                parts.push(textBlock(part.text));
            }
        }

        if (parts.length > 0) {
            return parts;
        }
    }

    return SafeJSON.stringify(content ?? "");
}

function mapMessage(message: Record<string, unknown>): AnthropicMessage | null {
    const role = message.role;

    if (role === "tool" && typeof message.tool_call_id === "string") {
        return {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: message.tool_call_id,
                    content: toolResultContent(message.content),
                },
            ],
        };
    }

    if (role === "assistant") {
        const blocks: AnthropicContentBlock[] = [...contentToBlocks(message.content), ...toolUseBlocksFromToolCalls(message.tool_calls)];

        if (blocks.length === 0) {
            return null;
        }

        return { role: "assistant", content: blocks };
    }

    const blocks = contentToBlocks(message.content);

    if (blocks.length === 0) {
        return null;
    }

    return { role: "user", content: blocks };
}

/** Merge adjacent same-role turns (Anthropic rejects consecutive same-role messages). */
function coalesce(messages: AnthropicMessage[]): AnthropicMessage[] {
    const merged: AnthropicMessage[] = [];

    for (const message of messages) {
        const last = merged.at(-1);

        if (last && last.role === message.role) {
            last.content.push(...message.content);
            continue;
        }

        merged.push(message);
    }

    return merged;
}

function extractSystem(messages: Record<string, unknown>[]): string | undefined {
    const parts: string[] = [];

    for (const message of messages) {
        if (message.role !== "system" && message.role !== "developer") {
            continue;
        }

        for (const block of contentToBlocks(message.content)) {
            if (block.type === "text") {
                parts.push(block.text);
            }
        }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function mapTools(tools: unknown): AnthropicTool[] | undefined {
    if (!Array.isArray(tools)) {
        return undefined;
    }

    const mapped: AnthropicTool[] = [];

    for (const tool of tools) {
        if (!isObject(tool)) {
            continue;
        }

        const fn = isObject(tool.function) ? tool.function : tool;
        const name = typeof fn.name === "string" ? fn.name : undefined;

        if (!name) {
            continue;
        }

        mapped.push({
            name,
            description: typeof fn.description === "string" ? fn.description : undefined,
            input_schema: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
        });
    }

    return mapped.length > 0 ? mapped : undefined;
}

function mapToolChoice(toolChoice: unknown): AnthropicToolChoice | undefined {
    if (toolChoice === "auto") {
        return { type: "auto" };
    }

    if (toolChoice === "required") {
        return { type: "any" };
    }

    if (toolChoice === "none") {
        return undefined;
    }

    if (isObject(toolChoice) && toolChoice.type === "function" && isObject(toolChoice.function)) {
        const name = toolChoice.function.name;

        if (typeof name === "string") {
            return { type: "tool", name };
        }
    }

    return undefined;
}

export function openAiChatToAnthropicMessages(
    body: OpenAiChatBody,
    options: OpenAiToAnthropicOptions
): AnthropicMessagesBody {
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const objectMessages = rawMessages.filter(isObject);

    const mapped: AnthropicMessage[] = [];

    for (const message of objectMessages) {
        if (message.role === "system" || message.role === "developer") {
            continue;
        }

        const anthropicMessage = mapMessage(message);

        if (anthropicMessage) {
            mapped.push(anthropicMessage);
        }
    }

    const result: AnthropicMessagesBody = {
        model: options.model,
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? options.maxTokensDefault ?? DEFAULT_MAX_TOKENS,
        messages: coalesce(mapped),
    };

    const system = extractSystem(objectMessages);

    if (system !== undefined) {
        result.system = system;
    }

    if (typeof body.temperature === "number") {
        result.temperature = body.temperature;
    }

    if (typeof body.top_p === "number") {
        result.top_p = body.top_p;
    }

    if (typeof body.stop === "string") {
        result.stop_sequences = [body.stop];
    } else if (Array.isArray(body.stop)) {
        result.stop_sequences = body.stop.filter((entry): entry is string => typeof entry === "string");
    }

    if (typeof body.stream === "boolean") {
        result.stream = body.stream;
    }

    const tools = mapTools(body.tools);

    if (tools) {
        result.tools = tools;

        const toolChoice = mapToolChoice(body.tool_choice);

        if (toolChoice) {
            result.tool_choice = toolChoice;
        }
    }

    return result;
}
