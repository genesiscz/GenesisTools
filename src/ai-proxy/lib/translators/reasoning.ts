import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

export interface ReasoningSummaryPart {
    type: string;
    text: string;
}

export interface ReasoningItem {
    id: string;
    type: "reasoning";
    encrypted_content?: string;
    summary: ReasoningSummaryPart[];
    content?: Array<{ type: string; text: string }>;
}

function summaryPartsFromItem(item: ReasoningItem | JsonObject): ReasoningSummaryPart[] {
    if (Array.isArray(item.summary)) {
        const parts: ReasoningSummaryPart[] = [];

        for (const summaryItem of item.summary) {
            if (!isObject(summaryItem) || typeof summaryItem.text !== "string") {
                continue;
            }

            parts.push({
                type: typeof summaryItem.type === "string" ? summaryItem.type : "summary_text",
                text: summaryItem.text,
            });
        }

        if (parts.length > 0) {
            return parts;
        }
    }

    if (!Array.isArray(item.content)) {
        return [];
    }

    const parts: ReasoningSummaryPart[] = [];

    for (const part of item.content) {
        if (!isObject(part) || typeof part.text !== "string") {
            continue;
        }

        if (part.type === "reasoning_text" || part.type === "summary_text" || part.type === "text") {
            parts.push({
                type: "summary_text",
                text: part.text,
            });
        }
    }

    return parts;
}

export function buildReasoningItem(item: JsonObject): ReasoningItem {
    const id = typeof item.id === "string" ? item.id : `rs_${crypto.randomUUID()}`;
    const summary = summaryPartsFromItem(item);
    const reasoningItem: ReasoningItem = {
        id,
        type: "reasoning",
        summary,
    };

    if (typeof item.encrypted_content === "string") {
        reasoningItem.encrypted_content = item.encrypted_content;
    }

    if (Array.isArray(item.content)) {
        const content: Array<{ type: string; text: string }> = [];

        for (const part of item.content) {
            if (!isObject(part) || typeof part.text !== "string" || typeof part.type !== "string") {
                continue;
            }

            content.push({ type: part.type, text: part.text });
        }

        if (content.length > 0) {
            reasoningItem.content = content;
        }
    }

    return reasoningItem;
}

export function reasoningContentFromItem(item: ReasoningItem | JsonObject): string {
    const summary = summaryPartsFromItem(item);
    return summary
        .map((part) => part.text)
        .join(" ")
        .trim();
}

export function reasoningItemToInput(item: ReasoningItem | JsonObject): JsonObject {
    const id = typeof item.id === "string" ? item.id : `rs_${crypto.randomUUID()}`;
    const input: JsonObject = {
        type: "reasoning",
        id,
        summary: Array.isArray(item.summary) ? item.summary : [],
    };

    if (typeof item.encrypted_content === "string") {
        input.encrypted_content = item.encrypted_content;
    }

    if (Array.isArray(item.content) && item.content.length > 0) {
        input.content = item.content;
    }

    return input;
}

export function reasoningItemsFromOutput(output: unknown[]): ReasoningItem[] {
    const items: ReasoningItem[] = [];

    for (const entry of output) {
        if (!isObject(entry) || entry.type !== "reasoning") {
            continue;
        }

        items.push(buildReasoningItem(entry));
    }

    return items;
}

export function reasoningItemsFromMessage(message: JsonObject): ReasoningItem[] {
    if (Array.isArray(message.reasoning_items)) {
        const items: ReasoningItem[] = [];

        for (const entry of message.reasoning_items) {
            if (!isObject(entry)) {
                continue;
            }

            items.push(buildReasoningItem(entry));
        }

        if (items.length > 0) {
            return items;
        }
    }

    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        return [
            {
                id: `rs_${crypto.randomUUID()}`,
                type: "reasoning",
                summary: [{ type: "summary_text", text: message.reasoning_content }],
                content: [{ type: "reasoning_text", text: message.reasoning_content }],
            },
        ];
    }

    return [];
}

export function transformResponsesUsage(usage: unknown): JsonObject | undefined {
    if (!isObject(usage)) {
        return undefined;
    }

    const promptTokens = usage.input_tokens ?? usage.prompt_tokens;
    const completionTokens = usage.output_tokens ?? usage.completion_tokens;

    if (promptTokens == null && completionTokens == null && usage.total_tokens == null) {
        return undefined;
    }

    const result: JsonObject = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage.total_tokens ?? Number(promptTokens ?? 0) + Number(completionTokens ?? 0),
    };

    const inputDetails = usage.input_tokens_details ?? usage.input_token_details;
    if (isObject(inputDetails)) {
        result.prompt_tokens_details = { ...inputDetails };
    }

    const outputDetails = usage.output_tokens_details ?? usage.output_token_details;
    if (isObject(outputDetails)) {
        result.completion_tokens_details = { ...outputDetails };
    }

    if (usage.cost_in_usd_ticks != null) {
        result.cost_in_usd_ticks = usage.cost_in_usd_ticks;
    }

    if (usage.num_sources_used != null) {
        result.num_sources_used = usage.num_sources_used;
    }

    return result;
}

export function serializeReasoningItems(items: ReasoningItem[]): JsonObject[] {
    return items as unknown as JsonObject[];
}
