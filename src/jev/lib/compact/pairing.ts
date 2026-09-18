import { type CompactMessage, roleKind } from "./schema";

export function isPairedToolResult(message: CompactMessage): boolean {
    if (roleKind(message.role) === "tool") {
        return true;
    }

    if (!Array.isArray(message.content)) {
        return false;
    }

    return message.content.some(
        (block) => block !== null && typeof block === "object" && "type" in block && block.type === "tool_result"
    );
}

export function toolPairId(message: CompactMessage): string | undefined {
    if (typeof message.tool_call_id === "string" && message.tool_call_id) {
        return message.tool_call_id;
    }

    if (typeof message.tool_use_id === "string" && message.tool_use_id) {
        return message.tool_use_id;
    }

    if (!Array.isArray(message.content)) {
        return undefined;
    }

    for (const block of message.content) {
        if (block === null || typeof block !== "object") {
            continue;
        }

        if (
            "id" in block &&
            typeof block.id === "string" &&
            (block.type === "tool_use" || block.type === "tool_result")
        ) {
            return block.id;
        }

        if ("tool_use_id" in block && typeof block.tool_use_id === "string") {
            return block.tool_use_id;
        }
    }

    return undefined;
}

export function isToolUse(message: CompactMessage): boolean {
    if (!Array.isArray(message.content)) {
        return false;
    }

    return message.content.some(
        (block) => block !== null && typeof block === "object" && "type" in block && block.type === "tool_use"
    );
}

export function pairToolCalls(messages: CompactMessage[]): Map<number, number> {
    const calls = new Map<string, number>();
    const pairs = new Map<number, number>();
    for (const message of messages) {
        const id = toolPairId(message);
        if (id && isToolUse(message)) {
            calls.set(id, message.index);
        }
    }

    for (const message of messages) {
        const id = toolPairId(message);
        if (!id || !isPairedToolResult(message)) {
            continue;
        }

        const callIndex = calls.get(id);
        if (callIndex === undefined) {
            continue;
        }

        pairs.set(callIndex, message.index);
        pairs.set(message.index, callIndex);
    }

    return pairs;
}
