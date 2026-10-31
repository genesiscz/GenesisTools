import { claudeMessagesToTurns } from "@genesiscz/utils/ai/transcripts/claude";
import { isRecord } from "@genesiscz/utils/ai/transcripts/resolve-core";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import type { ConversationMessage } from "@genesiscz/utils/claude/types";

export function claudeWindowTurns(values: Record<string, unknown>[]): TranscriptTurn[] {
    return claudeMessagesToTurns(values.filter(claudeMessage));
}

/** A conversation row of a Claude transcript: a user or assistant record whose content the turn builder reads. */
function claudeMessage(value: Record<string, unknown>): value is Record<string, unknown> & ConversationMessage {
    const message = isRecord(value.message) ? value.message : {};

    if (typeof value.uuid !== "string" || (value.type !== "user" && value.type !== "assistant")) {
        return false;
    }

    if (value.type === "user" && typeof message.content === "string") {
        return true;
    }

    return (
        Array.isArray(message.content) &&
        message.content.every(
            (part) =>
                isRecord(part) &&
                typeof part.type === "string" &&
                (part.type !== "text" || typeof part.text === "string") &&
                (part.type !== "tool_use" ||
                    (typeof part.id === "string" && typeof part.name === "string" && isRecord(part.input))) &&
                (part.type !== "tool_result" ||
                    !Array.isArray(part.content) ||
                    part.content.every(
                        (item) =>
                            isRecord(item) &&
                            typeof item.type === "string" &&
                            (item.type !== "text" || typeof item.text === "string")
                    ))
        )
    );
}
