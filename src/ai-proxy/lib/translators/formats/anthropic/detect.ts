function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function hasToolUseBlocks(messages: unknown): boolean {
    if (!Array.isArray(messages)) {
        return false;
    }

    return messages.some((message) => {
        if (!isRecord(message) || !Array.isArray(message.content)) {
            return false;
        }

        return message.content.some((part) => isRecord(part) && part.type === "tool_use");
    });
}

export function isAnthropicShapedBody(body: unknown): boolean {
    if (!isRecord(body)) {
        return false;
    }

    if ("anthropic_version" in body) {
        return true;
    }

    if (typeof body.system !== "undefined" && Array.isArray(body.messages)) {
        return true;
    }

    return hasToolUseBlocks(body.messages);
}
