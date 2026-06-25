/* Ported from _Playgrounds/copilot-for-cursor/anthropic-transforms.ts (inspiration only) */

import { SafeJSON } from "@app/utils/json";

type JsonRecord = Record<string, unknown>;

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

function sanitizeContentPart(part: unknown, isClaude: boolean): unknown | null {
    if (!part || typeof part !== "object") {
        return null;
    }

    const record = { ...(part as JsonRecord) };
    if ("cache_control" in record) {
        delete record.cache_control;
    }

    if (isClaude && (record.type === "image" || (record.source as JsonRecord | undefined)?.type === "base64")) {
        return { type: "text", text: "[Image Omitted]" };
    }

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

    for (const field of ["metadata", "anthropic_version", "top_k", "thinking"]) {
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

function transformMessages(json: JsonRecord, isClaude: boolean): void {
    if (!Array.isArray(json.messages)) {
        return;
    }

    const newMessages: JsonRecord[] = [];

    for (const message of json.messages) {
        const msg = message as JsonRecord;

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

                newMessages.push({
                    role: "tool",
                    tool_call_id: tr.tool_use_id,
                    content: resultContent || "",
                });
            }

            if (otherParts.length > 0) {
                const cleaned = otherParts
                    .map((part) => sanitizeContentPart(part, isClaude))
                    .filter((part): part is NonNullable<typeof part> => part !== null);

                if (cleaned.length > 0) {
                    newMessages.push({ role: "user", content: cleaned });
                }
            }

            continue;
        }

        if (Array.isArray(msg.content)) {
            const cleaned = msg.content
                .map((part) => sanitizeContentPart(part, isClaude))
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

export function normalizeAnthropicToOpenAI(body: JsonRecord, isClaude = true): void {
    transformAnthropicFields(body);
    transformTools(body);
    transformToolChoice(body);
    transformMessages(body, isClaude);
}
