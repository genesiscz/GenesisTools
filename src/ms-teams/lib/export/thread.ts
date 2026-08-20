import { SafeJSON } from "@genesiscz/utils/json";
import { isSystemMessageType } from "../ingest-parse";
import type { TeamsCache } from "../store";
import type {
    Attachment,
    ExportedMessage,
    ListMessagesOptions,
    Mention,
    MessageRow,
    Person,
    Reaction,
    ThreadExport,
} from "../types";
import { COMPLETENESS_NOTE } from "../types";

export function exportThread(cache: TeamsCache, conversationId: string, opts: ListMessagesOptions = {}): ThreadExport {
    const conversation = cache.getConversation(conversationId);

    if (!conversation) {
        throw new Error(`Conversation not found: ${conversationId}`);
    }

    const messages = cache.listMessages(conversationId, opts);
    const byId = new Map(messages.map((m) => [m.id, m]));
    const exported = messages.map((row) => toExported(row, byId));
    const first = messages[0];
    const last = messages[messages.length - 1];
    const cachedFrom = first ? new Date(first.originalArrivalTime).toISOString() : null;
    const cachedTo = last ? new Date(last.originalArrivalTime).toISOString() : null;
    let members: Person[] = [];

    try {
        const parsed = SafeJSON.parse(conversation.membersJson);
        members = Array.isArray(parsed) ? parsed : [];
    } catch {
        members = [];
    }

    return {
        conversation: {
            id: conversation.id,
            type: conversation.type,
            title: conversation.title,
            topic: conversation.topic,
            members: Array.isArray(members) ? members : [],
            cachedFrom,
            cachedTo,
            messageCount: exported.length,
            completenessNote: COMPLETENESS_NOTE,
        },
        messages: exported,
    };
}

function toExported(row: MessageRow, byId: Map<string, MessageRow>): ExportedMessage {
    const reply = row.replyToId ? byId.get(row.replyToId) : undefined;
    const system = isSystemMessageType(row.messageType) ? row.text || row.messageType : null;

    return {
        id: row.id,
        sequenceId: row.sequenceId,
        time: new Date(row.originalArrivalTime).toISOString(),
        from: {
            mri: row.fromMri ?? "",
            displayName: row.fromName ?? row.fromMri ?? "unknown",
            email: null,
        },
        isFromMe: row.isFromMe,
        messageType: row.messageType,
        text: row.text,
        html: row.html,
        replyToId: row.replyToId,
        replyTo: reply
            ? {
                  id: reply.id,
                  from: reply.fromName ?? "unknown",
                  excerpt: (reply.text || "").slice(0, 140),
              }
            : null,
        reactions: parseJsonArray<Reaction>(row.reactionsJson),
        mentions: parseJsonArray<Mention>(row.mentionsJson),
        links: parseJsonArray<string>(row.linksJson),
        attachments: parseJsonArray<Attachment>(row.attachmentsJson),
        call: row.messageType === "Event/Call" ? { state: row.text || "call" } : null,
        system,
    };
}

function parseJsonArray<T>(raw: string): T[] {
    try {
        const value = SafeJSON.parse(raw);
        return Array.isArray(value) ? (value as T[]) : [];
    } catch {
        return [];
    }
}
