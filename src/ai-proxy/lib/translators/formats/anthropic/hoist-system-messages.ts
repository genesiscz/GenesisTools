import { logger } from "@genesiscz/utils/logger";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBlocksFrom(content: unknown): JsonRecord[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter(
        (block): block is JsonRecord => isJsonRecord(block) && block.type === "text" && typeof block.text === "string"
    );
}

/**
 * Claude Code sometimes puts a `role: "system"` entry inside `messages[]`.
 * OpenAI-shaped upstreams accept that natively, so the translated path never
 * noticed — but Grok's native /v1/messages rejects it with
 * `Invalid message role` (observed live 2026-08-19, first headless Claude Code
 * run over the passthrough). Move such entries into the top-level `system`
 * array, where the Anthropic shape says they belong. Pure — returns a clone
 * when it changes anything.
 */
export function hoistSystemMessages(body: JsonRecord): JsonRecord {
    if (!Array.isArray(body.messages)) {
        return body;
    }

    const hasSystemRole = body.messages.some((message) => isJsonRecord(message) && message.role === "system");

    if (!hasSystemRole) {
        return body;
    }

    const next = structuredClone(body);
    const messages = next.messages as unknown[];
    const hoisted: JsonRecord[] = [];

    next.messages = messages.filter((message) => {
        if (isJsonRecord(message) && message.role === "system") {
            const blocks = textBlocksFrom(message.content);

            // Anthropic's system[] takes text blocks only, so anything else is
            // dropped — say so instead of losing content silently.
            if (Array.isArray(message.content) && message.content.length > blocks.length) {
                logger.debug(
                    { dropped: message.content.length - blocks.length },
                    "ai-proxy: hoisted system message dropped non-text blocks"
                );
            }

            hoisted.push(...blocks);
            return false;
        }

        return true;
    });

    const system =
        typeof next.system === "string"
            ? [{ type: "text", text: next.system }]
            : Array.isArray(next.system)
              ? next.system
              : [];

    next.system = [...system, ...hoisted];

    return next;
}
