/* Ported from _Playgrounds/copilot-for-cursor/anthropic-transforms.ts (inspiration only) */

import { REASONING_EFFORT_SUFFIXES } from "@app/ai-proxy/lib/resolve-model";
import type { ReasoningEffort } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== "object") {
        return schema;
    }

    const record = schema as JsonRecord;
    if ("additionalProperties" in record) {
        delete record.additionalProperties;
    }
    if ("$schema" in record) {
        delete record.$schema;
    }
    if ("title" in record) {
        delete record.title;
    }

    if (record.properties && typeof record.properties === "object") {
        for (const key of Object.keys(record.properties as JsonRecord)) {
            cleanSchema((record.properties as JsonRecord)[key]);
        }
    }

    if (record.items) {
        cleanSchema(record.items);
    }

    return record;
}

function sanitizeContentPart(part: unknown): unknown | null {
    if (!part || typeof part !== "object") {
        return null;
    }

    const record = { ...(part as JsonRecord) };
    if ("cache_control" in record) {
        delete record.cache_control;
    }

    // The playground port this file came from replaced every image with the literal
    // text "[Image Omitted]" when the model id contained "claude". That silently
    // blinded claude-named models reached through translation (OpenRouter's claude
    // models accept image_url). Images now translate uniformly; an upstream that
    // truly cannot take them will say so with a 400 instead of losing data quietly.
    if (record.type === "image" && (record.source as JsonRecord | undefined)?.type === "base64") {
        const source = record.source as JsonRecord;
        return {
            type: "image_url",
            image_url: { url: `data:${source.media_type};base64,${source.data}` },
        };
    }

    if (record.type === "image") {
        record.type = "image_url";
        return record;
    }

    if (record.type === "text" || record.type === "image_url") {
        return record;
    }

    return null;
}

function transformAnthropicFields(json: JsonRecord): void {
    if (json.system) {
        const systemText =
            typeof json.system === "string"
                ? json.system
                : Array.isArray(json.system)
                  ? json.system
                        .map((entry) => {
                            if (typeof entry === "string") {
                                return entry;
                            }

                            if (entry && typeof entry === "object") {
                                return String((entry as JsonRecord).text ?? "");
                            }

                            return "";
                        })
                        .join("\n")
                  : String(json.system);

        if (Array.isArray(json.messages)) {
            const hasSystem = json.messages.some((message) => (message as JsonRecord).role === "system");
            if (!hasSystem) {
                json.messages.unshift({ role: "system", content: systemText });
            }
        }

        delete json.system;
    }

    if (json.stop_sequences) {
        json.stop = json.stop_sequences;
        delete json.stop_sequences;
    }

    if (json.max_tokens_to_sample && !json.max_tokens) {
        json.max_tokens = json.max_tokens_to_sample;
        delete json.max_tokens_to_sample;
    }

    // Claude Code's `/effort` command travels as `output_config.effort`, using
    // exactly the vocabulary (low/medium/high/xhigh/max) that OpenAI-shaped
    // upstreams take as `reasoning_effort`. Deleting the field unread threw the
    // user's setting away: 23 recorded requests asked for xhigh and every one
    // reached the upstream at the model's default. Translate it, do not drop it.
    //
    // The client's own `reasoning_effort` wins, which keeps a deliberate
    // `model:xhigh` pin (stamped upstream of this by applyReasoningEffortToBody)
    // ahead of the live session setting.
    const outputConfig = json.output_config;

    if (isJsonRecord(outputConfig)) {
        if (typeof outputConfig.effort === "string") {
            const effort = outputConfig.effort.trim();
            // Only known efforts are forwarded: an unrecognised string reaching an
            // upstream is a 400 for the whole request, and silently dropping the
            // field degrades to the model default instead.
            const existing = typeof json.reasoning_effort === "string" ? json.reasoning_effort.trim() : "";

            if (REASONING_EFFORT_SUFFIXES.includes(effort as ReasoningEffort) && existing.length === 0) {
                json.reasoning_effort = effort;
            }
        }

        // `output_config.format` is Anthropic's structured-output request. Deleting it
        // unread let a schema-constrained call run free-form: one recorded request
        // looped for 11m44s / 152,551 characters until stop_reason=length. OpenAI-shaped
        // upstreams take exactly this as `response_format.json_schema`.
        if (json.response_format === undefined) {
            const format = outputConfig.format;

            if (isJsonRecord(format) && format.type === "json_schema" && isJsonRecord(format.schema)) {
                json.response_format = {
                    type: "json_schema",
                    json_schema: { name: "structured_output", schema: format.schema },
                };
            }
        }
    }

    // Anthropic-only request fields with no OpenAI equivalent. `context_management`
    // and `output_config` are sent by Claude Code on every turn and were being
    // forwarded verbatim: Grok tolerates unknown parameters, but stricter upstreams
    // (xAI, OpenAI) answer 400, so the leak was a latent failure on those providers.
    for (const field of ["metadata", "anthropic_version", "top_k", "thinking", "context_management", "output_config"]) {
        if (field in json) {
            delete json[field];
        }
    }
}

function transformTools(json: JsonRecord): void {
    if (!Array.isArray(json.tools)) {
        return;
    }

    json.tools = json.tools.map((tool) => {
        const entry = tool as JsonRecord;
        let parameters: unknown = entry.input_schema || entry.parameters || {};
        parameters = cleanSchema(parameters);

        if (entry.type === "function" && entry.function) {
            const fn = entry.function as JsonRecord;
            fn.parameters = cleanSchema(fn.parameters);
            return entry;
        }

        return {
            type: "function",
            function: {
                name: entry.name,
                description: entry.description,
                parameters,
            },
        };
    });
}

function transformToolChoice(json: JsonRecord): void {
    if (!json.tool_choice || typeof json.tool_choice !== "object") {
        return;
    }

    const choice = json.tool_choice as JsonRecord;

    if (choice.type === "auto") {
        json.tool_choice = "auto";
    } else if (choice.type === "none") {
        json.tool_choice = "none";
    } else if (choice.type === "required" || choice.type === "any") {
        json.tool_choice = "required";
    } else if (choice.type === "tool" && choice.name) {
        json.tool_choice = { type: "function", function: { name: choice.name } };
    }
}

function transformMessages(json: JsonRecord): void {
    if (!Array.isArray(json.messages)) {
        return;
    }

    const newMessages: JsonRecord[] = [];

    for (const message of json.messages) {
        const msg = message as JsonRecord;

        // Assistant `thinking` blocks are dropped here on purpose: the OpenAI chat
        // shape has no request slot for replayed reasoning, and the upstreams this
        // translator serves either ignore or reject one. Providers whose upstream
        // speaks Anthropic natively must implement `ProxyProvider.messages()` and
        // skip this translation entirely — that is where reasoning continuity lives.
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            const textParts: string[] = [];
            const toolCalls: JsonRecord[] = [];

            for (const part of msg.content) {
                const block = part as JsonRecord;
                if (block.type === "tool_use") {
                    toolCalls.push({
                        id: block.id,
                        type: "function",
                        function: {
                            name: block.name,
                            arguments:
                                typeof block.input === "string" ? block.input : SafeJSON.stringify(block.input ?? {}),
                        },
                    });
                } else if (block.type === "text") {
                    textParts.push(String(block.text ?? ""));
                }
            }

            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const existing = tc as JsonRecord;
                    if (!toolCalls.some((item) => item.id === existing.id)) {
                        toolCalls.push(existing);
                    }
                }
            }

            const assistantMsg: JsonRecord = { role: "assistant", content: textParts.join("\n") || null };
            if (toolCalls.length > 0) {
                assistantMsg.tool_calls = toolCalls;
            }
            newMessages.push(assistantMsg);
            continue;
        }

        if (msg.role === "user" && Array.isArray(msg.content)) {
            const toolResults = msg.content.filter((part) => (part as JsonRecord).type === "tool_result");
            const otherParts = msg.content.filter(
                (part) => !["tool_result", "tool_use"].includes((part as JsonRecord).type as string)
            );

            for (const result of toolResults) {
                const tr = result as JsonRecord;
                let resultContent = tr.content;
                if (typeof resultContent !== "string") {
                    if (Array.isArray(resultContent)) {
                        resultContent = resultContent
                            .map((part) => {
                                const block = part as JsonRecord;
                                if (block.type === "text") {
                                    return block.text || "";
                                }
                                if (
                                    block.type === "image" ||
                                    (block.source as JsonRecord | undefined)?.type === "base64"
                                ) {
                                    return "[Image Omitted]";
                                }
                                return SafeJSON.stringify(block);
                            })
                            .join("\n");
                    } else {
                        resultContent = SafeJSON.stringify(resultContent);
                    }
                }

                // The OpenAI tool message has no error flag, so a failed call that
                // arrives as `is_error: true` must be marked in the text or the model
                // cannot tell it from a success. 32 real failures crossed this path
                // unmarked before this prefix existed.
                const failedPrefix = tr.is_error === true ? "[Tool call failed] " : "";

                newMessages.push({
                    role: "tool",
                    tool_call_id: tr.tool_use_id,
                    content: `${failedPrefix}${resultContent || ""}`,
                });
            }

            if (otherParts.length > 0) {
                const cleaned = otherParts
                    .map((part) => sanitizeContentPart(part))
                    .filter((part): part is NonNullable<typeof part> => part !== null);

                if (cleaned.length > 0) {
                    newMessages.push({ role: "user", content: cleaned });
                }
            }

            continue;
        }

        if (Array.isArray(msg.content)) {
            const cleaned = msg.content
                .map((part) => sanitizeContentPart(part))
                .filter((part): part is NonNullable<typeof part> => part !== null);
            msg.content = cleaned.length > 0 ? cleaned : " ";
        }

        newMessages.push(msg);
    }

    json.messages = newMessages;

    for (const message of json.messages as JsonRecord[]) {
        if (Array.isArray(message.content) && message.content.length === 0) {
            message.content = " ";
        }

        if (
            Array.isArray(message.content) &&
            message.content.length === 1 &&
            (message.content[0] as JsonRecord).type === "text"
        ) {
            message.content = (message.content[0] as JsonRecord).text || " ";
        }
    }
}

export function normalizeAnthropicToOpenAI(body: JsonRecord): void {
    transformAnthropicFields(body);
    transformTools(body);
    transformToolChoice(body);
    transformMessages(body);
}
