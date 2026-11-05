/** The Claude reader's `midWork` member: was the agent still working when its transcript was last written? */
import type { JsonRecord } from "@genesiscz/utils/ai/transcripts/turn-state-types";
import { isObject } from "@genesiscz/utils/object";

/** A teammate's last act before its process exits: `SendMessage` with an approving `shutdown_response`. */
function approvesShutdown(part: unknown): boolean {
    if (!isObject(part) || part.type !== "tool_use" || part.name !== "SendMessage" || !isObject(part.input)) {
        return false;
    }

    const reply = part.input.message;
    return isObject(reply) && reply.type === "shutdown_response" && reply.approve === true;
}

/** The newest conversation record: progress and attachment rows do not say where the agent is. */
function lastConversationRecord(records: readonly JsonRecord[]): JsonRecord | null {
    for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];

        if (record.type === "assistant" || record.type === "user") {
            return record;
        }
    }

    return null;
}

/**
 * A prompt, a tool result or a tool call as the last conversation record means the agent still works; so does a reply
 * that is still streaming (`stop_reason: null`). A teammate that approved its shutdown is done. No conversation record
 * at all counts as working: the file holds only a spawn that has not answered yet.
 */
export function claudeMidWork(records: readonly JsonRecord[]): boolean {
    const last = lastConversationRecord(records);

    if (!last || last.type === "user") {
        return true;
    }

    const message = isObject(last.message) ? last.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];

    if (content.some(approvesShutdown)) {
        return false;
    }

    if (content.some((part) => isObject(part) && part.type === "tool_use")) {
        return true;
    }

    return message?.stop_reason === null;
}
