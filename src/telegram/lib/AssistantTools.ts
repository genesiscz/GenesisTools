import type { AIChatTool } from "@ask/lib/types";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";

function asString(value: unknown): string | undefined {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }

    return undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return undefined;
}

function parseOptionalDate(value: unknown): Date | undefined {
    const text = asString(value);

    if (!text) {
        return undefined;
    }

    const date = new Date(text);

    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    return date;
}

export function createAssistantTools(store: TelegramHistoryStore, chatId: string): Record<string, AIChatTool> {
    return {
        query_messages: {
            description:
                "Query conversation messages from local DB for this chat by optional date/sender/text filters.",
            parameters: {
                since: { type: "string", description: "Optional ISO date or YYYY-MM-DD start date", optional: true },
                until: { type: "string", description: "Optional ISO date or YYYY-MM-DD end date", optional: true },
                sender: {
                    type: "string",
                    description: "me|them|any (default any)",
                    optional: true,
                },
                textRegex: { type: "string", description: "Optional regex filter", optional: true },
                limit: { type: "number", description: "Optional max rows", optional: true },
            },
            execute: async (params: Record<string, unknown>) => {
                const senderRaw = asString(params.sender);
                const sender = senderRaw === "me" || senderRaw === "them" || senderRaw === "any" ? senderRaw : "any";

                const rows = store.queryMessages(chatId, {
                    since: parseOptionalDate(params.since),
                    until: parseOptionalDate(params.until),
                    sender,
                    textRegex: asString(params.textRegex),
                    limit: asNumber(params.limit),
                });

                return rows.map((row) => ({
                    id: row.id,
                    date: row.date_iso,
                    sender: row.is_outgoing ? "me" : "them",
                    text: row.text,
                    media: row.media_desc,
                    deleted: row.is_deleted === 1,
                }));
            },
        },
        search_messages: {
            description: "FTS keyword search in this chat's local DB index.",
            parameters: {
                query: { type: "string", description: "Search query text" },
                limit: { type: "number", description: "Optional result count", optional: true },
            },
            execute: async (params: Record<string, unknown>) => {
                const query = asString(params.query);

                if (!query) {
                    return [];
                }

                const results = store.search(chatId, query, {
                    limit: asNumber(params.limit),
                });

                return results.map((result) => ({
                    id: result.message.id,
                    date: result.message.date_iso,
                    sender: result.message.is_outgoing ? "me" : "them",
                    text: result.message.text,
                    media: result.message.media_desc,
                }));
            },
        },
        list_attachments: {
            description: "List indexed attachment locators for this chat.",
            parameters: {
                limit: { type: "number", description: "Optional max rows", optional: true },
            },
            execute: async (params: Record<string, unknown>) => {
                const rows = store.listAttachments(chatId, { limit: asNumber(params.limit) });

                return rows.map((row) => ({
                    locator: `${row.chat_id}:${row.message_id}:${row.attachment_index}`,
                    messageId: row.message_id,
                    attachmentIndex: row.attachment_index,
                    kind: row.kind,
                    fileName: row.file_name,
                    mimeType: row.mime_type,
                    downloaded: row.is_downloaded === 1,
                }));
            },
        },
        get_stats: {
            description: "Return message and embedding stats for this chat.",
            parameters: {},
            execute: async () => {
                const stats = store.getStats(chatId)[0];

                if (!stats) {
                    return null;
                }

                return stats;
            },
        },
        get_suggestion_feedback: {
            description: "Return recent suggestion feedback (suggested text vs edited sent text).",
            parameters: {
                limit: { type: "number", description: "Optional max rows", optional: true },
            },
            execute: async (params: Record<string, unknown>) => {
                return store.getSuggestionFeedback(chatId, asNumber(params.limit) ?? 20);
            },
        },
    };
}
