import { reasoningItemsFromMessage, reasoningItemToInput } from "@app/ai-proxy/lib/translators/reasoning";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

function contentToParts(content: unknown, textType: "input_text" | "output_text"): unknown[] {
    if (typeof content === "string") {
        return [{ type: textType, text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ type: textType, text: content == null ? "" : String(content) }];
    }

    return content.map((part) => {
        if (!isObject(part)) {
            return part;
        }

        if (part.type === "text" && typeof part.text === "string") {
            return { type: textType, text: part.text };
        }

        if (part.type === "input_text" || part.type === "output_text") {
            return part;
        }

        return part;
    });
}

function convertAssistantMessage(message: JsonObject): unknown[] {
    const items: unknown[] = [];

    for (const reasoningItem of reasoningItemsFromMessage(message)) {
        items.push(reasoningItemToInput(reasoningItem));
    }

    if (message.content !== undefined && message.content !== null && message.content !== "") {
        items.push({
            role: "assistant",
            content: contentToParts(message.content, "output_text"),
        });
    }

    if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
            if (!isObject(toolCall)) {
                continue;
            }

            const fn = isObject(toolCall.function) ? toolCall.function : {};
            const callId =
                typeof toolCall.id === "string"
                    ? toolCall.id
                    : typeof toolCall.call_id === "string"
                      ? toolCall.call_id
                      : `call_${crypto.randomUUID()}`;

            items.push({
                type: "function_call",
                name: typeof fn.name === "string" ? fn.name : "unknown",
                arguments: typeof fn.arguments === "string" ? fn.arguments : SafeJSON.stringify(fn.arguments ?? {}),
                call_id: callId,
            });
        }
    }

    if (items.length === 0) {
        items.push({
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
        });
    }

    return items;
}

export function convertMessageToInputItems(message: JsonObject): unknown[] {
    const role = message.role;

    if (role === "tool" && typeof message.tool_call_id === "string") {
        const output =
            typeof message.content === "string" ? message.content : SafeJSON.stringify(message.content ?? "");

        return [
            {
                type: "function_call_output",
                call_id: message.tool_call_id,
                output,
            },
        ];
    }

    if (role === "assistant") {
        return convertAssistantMessage(message);
    }

    if (role === "system") {
        return [
            {
                role: "developer",
                content: contentToParts(message.content, "input_text"),
            },
        ];
    }

    return [
        {
            role: "user",
            content: contentToParts(message.content, "input_text"),
        },
    ];
}

export function convertMessagesToInput(messages: unknown[]): unknown[] {
    const input: unknown[] = [];

    for (const message of messages) {
        if (!isObject(message)) {
            continue;
        }

        input.push(...convertMessageToInputItems(message));
    }

    return input;
}

export function ensureResponsesInput(body: JsonObject): JsonObject {
    if ("input" in body) {
        return body;
    }

    if (!Array.isArray(body.messages)) {
        return body;
    }

    const next: JsonObject = { ...body };
    next.input = convertMessagesToInput(body.messages);
    delete next.messages;

    return next;
}
