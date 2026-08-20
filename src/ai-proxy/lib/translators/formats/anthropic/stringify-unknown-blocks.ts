import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GROK_KNOWN_RESULT_BLOCKS = new Set(["text", "image"]);

/**
 * Claude Code puts proprietary block types inside `tool_result.content` —
 * ToolSearch results carry `{type:"tool_reference", tool_name:…}`. Anthropic
 * accepts them; Grok's deserializer rejects the WHOLE request with
 * `422 data did not match any variant of untagged enum MessageContent`
 * (observed live 2026-08-19, session e57f83a9/8dfb08ea class). Unknown block
 * types become text blocks carrying their own JSON, so no information is lost
 * and the model still sees what the tool returned. Pure — clones on change.
 */
export function stringifyUnknownToolResultBlocks(body: JsonRecord): JsonRecord {
    if (!Array.isArray(body.messages)) {
        return body;
    }

    const needsFix = body.messages.some(
        (message) =>
            isJsonRecord(message) &&
            Array.isArray(message.content) &&
            message.content.some(
                (block) =>
                    isJsonRecord(block) &&
                    block.type === "tool_result" &&
                    Array.isArray(block.content) &&
                    block.content.some((part) => isJsonRecord(part) && !GROK_KNOWN_RESULT_BLOCKS.has(String(part.type)))
            )
    );

    if (!needsFix) {
        return body;
    }

    const next = structuredClone(body);
    const converted = new Set<string>();

    for (const message of next.messages as unknown[]) {
        if (!isJsonRecord(message) || !Array.isArray(message.content)) {
            continue;
        }

        for (const block of message.content) {
            if (!isJsonRecord(block) || block.type !== "tool_result" || !Array.isArray(block.content)) {
                continue;
            }

            block.content = block.content.map((part) => {
                if (isJsonRecord(part) && !GROK_KNOWN_RESULT_BLOCKS.has(String(part.type))) {
                    converted.add(String(part.type));
                    return { type: "text", text: SafeJSON.stringify(part) ?? "" };
                }

                return part;
            });
        }
    }

    logger.debug(
        { blockTypes: [...converted] },
        "ai-proxy: stringified tool_result block types the grok deserializer rejects"
    );

    return next;
}
