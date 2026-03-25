import { SafeJSON } from "@app/utils/json";
import type { ConversationMessage, TextBlock, ToolResultBlock, ToolUseBlock } from "./types";

/** Shorthand "A" variant that some JSONL sessions use for assistant messages. */
interface ShorthandAssistant {
    type: "A";
    message?: { stop_reason?: string | null };
}

export function extractToolInputSummary(tool: ToolUseBlock): string {
    const input = tool.input;

    if ("command" in input && typeof input.command === "string") {
        return input.command;
    }

    if ("file_path" in input && typeof input.file_path === "string") {
        return input.file_path;
    }

    if ("pattern" in input && typeof input.pattern === "string") {
        return input.pattern;
    }

    if ("query" in input && typeof input.query === "string") {
        return input.query;
    }

    if ("skill" in input && typeof input.skill === "string") {
        return input.skill;
    }

    const safeInput = SafeJSON.stringify(input);
    return safeInput;
}

export function extractToolResultText(block: ToolResultBlock): string {
    if (typeof block.content === "string") {
        return block.content;
    }

    if (Array.isArray(block.content)) {
        return block.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    }

    return "";
}

export function isAssistantEndTurn(record: ConversationMessage): boolean {
    if (record.type === "assistant") {
        return record.message?.stop_reason === "end_turn";
    }

    const raw = record as unknown as ShorthandAssistant;

    if (raw.type !== "A") {
        return false;
    }

    return raw.message?.stop_reason === "end_turn";
}
