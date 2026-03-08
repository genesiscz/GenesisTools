import { AIChat } from "@app/ask/index.lib";
import { z } from "zod";
import { parseDate } from "./DateParser";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import type { AskModeConfig, TelegramContactV2 } from "./types";
import { DEFAULTS } from "./types";

const searchMessagesSchema = z.object({
    query: z.string().optional().describe("Text to search for"),
    since: z.string().optional().describe("Start date (ISO or natural language like 'last week')"),
    until: z.string().optional().describe("End date (ISO or natural language)"),
    sender: z.enum(["me", "them", "any"]).optional().describe("Filter by sender"),
    limit: z.number().optional().describe("Max results (default 20)"),
});

const messageCountSchema = z.object({
    since: z.string().optional(),
    until: z.string().optional(),
    sender: z.enum(["me", "them", "any"]).optional(),
});

const conversationSummarySchema = z.object({
    since: z.string().describe("Start date"),
    until: z.string().optional().describe("End date (defaults to now)"),
    limit: z.number().optional().describe("Max results (default 50)"),
});

const attachmentsSchema = z.object({
    messageId: z.number().optional().describe("Specific message ID"),
    since: z.string().optional(),
    until: z.string().optional(),
});

const styleAnalysisSchema = z.object({
    sender: z.enum(["me", "them"]).describe("Whose style to analyze"),
    limit: z.number().optional().describe("Number of messages to analyze (default 200)"),
});

const searchAcrossChatsSchema = z.object({
    query: z.string().describe("Text to search for"),
    limit: z.number().optional().describe("Max results (default 20)"),
});

type SearchMessagesInput = z.infer<typeof searchMessagesSchema>;
type MessageCountInput = z.infer<typeof messageCountSchema>;
type ConversationSummaryInput = z.infer<typeof conversationSummarySchema>;
type AttachmentsInput = z.infer<typeof attachmentsSchema>;
type StyleAnalysisInput = z.infer<typeof styleAnalysisSchema>;
type SearchAcrossChatsInput = z.infer<typeof searchAcrossChatsSchema>;

export class AssistantEngine {
    private chat: AIChat | null = null;

    constructor(
        private store: TelegramHistoryStore,
        private contact: TelegramContactV2,
        private myName: string
    ) {}

    private getConfig(): AskModeConfig {
        return this.contact.modes.assistant;
    }

    private ensureChat(): AIChat {
        if (!this.chat) {
            const config = this.getConfig();
            this.chat = new AIChat({
                provider: config.provider ?? DEFAULTS.askProvider,
                model: config.model ?? DEFAULTS.askModel,
                systemPrompt: this.buildSystemPrompt(config),
                temperature: config.temperature ?? 0.7,
                session: {
                    id: `telegram-assistant-${this.contact.userId}`,
                    dir: `${process.env.HOME}/.genesis-tools/telegram/ai-sessions`,
                    autoSave: true,
                },
            });
        }

        return this.chat;
    }

    private buildSystemPrompt(config: AskModeConfig): string {
        return (
            config.systemPrompt ??
            [
                `You are a helpful assistant analyzing a Telegram conversation between "${this.myName}" and "${this.contact.displayName}".`,
                "You have access to tools that let you search the full message history.",
                "Use the tools to find relevant messages before answering questions.",
                "Be concise but thorough. Reference specific messages when relevant.",
            ].join("\n")
        );
    }

    buildTools() {
        const store = this.store;
        const contactId = this.contact.userId;

        return {
            search_messages: {
                description: "Search messages in the conversation by text content, date range, or sender",
                parameters: searchMessagesSchema,
                execute: async (input: SearchMessagesInput) => {
                    const results = store.queryMessages(contactId, {
                        textPattern: input.query,
                        since: input.since ? (parseDate(input.since) ?? undefined) : undefined,
                        until: input.until ? (parseDate(input.until) ?? undefined) : undefined,
                        sender: input.sender ?? "any",
                        limit: input.limit ?? 20,
                    });

                    return results.map((r) => ({
                        id: r.id,
                        date: r.date_iso,
                        sender: r.is_outgoing ? "me" : "them",
                        text: r.text ?? "[media]",
                    }));
                },
            },

            get_message_count: {
                description: "Count messages matching filters",
                parameters: messageCountSchema,
                execute: async (input: MessageCountInput) => {
                    const count = store.countMessages(contactId, {
                        since: input.since ? (parseDate(input.since) ?? undefined) : undefined,
                        until: input.until ? (parseDate(input.until) ?? undefined) : undefined,
                        sender: input.sender ?? "any",
                    });
                    return { count };
                },
            },

            get_conversation_summary: {
                description: "Get a summary of messages in a date range. Returns messages for you to summarize.",
                parameters: conversationSummarySchema,
                execute: async (input: ConversationSummaryInput) => {
                    const results = store.queryMessages(contactId, {
                        since: parseDate(input.since) ?? undefined,
                        until: input.until ? (parseDate(input.until) ?? undefined) : undefined,
                        limit: input.limit ?? 50,
                    });

                    return results.map((r) => ({
                        date: r.date_iso,
                        sender: r.is_outgoing ? "me" : "them",
                        text: r.text ?? "[media]",
                    }));
                },
            },

            get_attachments: {
                description: "List attachments (photos, videos, documents) in messages",
                parameters: attachmentsSchema,
                execute: async (input: AttachmentsInput) => {
                    if (input.messageId) {
                        return store.getAttachments(contactId, input.messageId);
                    }

                    return store.listAttachments(contactId, {
                        since: input.since ? (parseDate(input.since) ?? undefined) : undefined,
                        until: input.until ? (parseDate(input.until) ?? undefined) : undefined,
                    });
                },
            },

            get_style_analysis: {
                description:
                    "Analyze writing style patterns for a sender (message length, emoji usage, common phrases)",
                parameters: styleAnalysisSchema,
                execute: async (input: StyleAnalysisInput) => {
                    const messages = store.queryMessages(contactId, {
                        sender: input.sender,
                        limit: input.limit ?? 200,
                    });

                    const texts = messages.map((m) => m.text ?? "").filter(Boolean);
                    const avgLength = texts.reduce((sum, t) => sum + t.length, 0) / (texts.length || 1);
                    const emojiCount = texts.reduce((sum, t) => sum + (t.match(/[\p{Emoji}]/gu) ?? []).length, 0);
                    const avgWords = texts.reduce((sum, t) => sum + t.split(/\s+/).length, 0) / (texts.length || 1);

                    return {
                        totalMessages: texts.length,
                        avgCharLength: Math.round(avgLength),
                        avgWordCount: Math.round(avgWords),
                        totalEmojis: emojiCount,
                        emojisPerMessage: (emojiCount / (texts.length || 1)).toFixed(2),
                        sampleMessages: texts.slice(-10),
                    };
                },
            },

            search_across_chats: {
                description: "Search for text across ALL synced chats, not just the current one",
                parameters: searchAcrossChatsSchema,
                execute: async (input: SearchAcrossChatsInput) => {
                    const chats = store.listChats();
                    const allResults: Array<{
                        chatId: string;
                        chatTitle: string;
                        date: string;
                        sender: string;
                        text: string;
                    }> = [];

                    for (const chat of chats) {
                        const results = store.queryMessages(chat.chat_id, {
                            textPattern: input.query,
                            limit: 5,
                        });

                        for (const r of results) {
                            allResults.push({
                                chatId: chat.chat_id,
                                chatTitle: chat.title,
                                date: r.date_iso,
                                sender: r.is_outgoing ? "me" : chat.title,
                                text: r.text ?? "[media]",
                            });
                        }
                    }

                    return allResults.slice(0, input.limit ?? 20);
                },
            },
        };
    }

    async ask(question: string): Promise<string> {
        const chat = this.ensureChat();
        const response = await chat.send(question);
        return response.content;
    }

    static getToolDefinitions() {
        return {
            search_messages: {
                parameters: { query: "string", since: "string", until: "string", sender: "string", limit: "number" },
            },
            get_message_count: { parameters: { since: "string", until: "string", sender: "string" } },
            get_conversation_summary: { parameters: { since: "string", until: "string", limit: "number" } },
            get_attachments: { parameters: { messageId: "number", since: "string", until: "string" } },
            get_style_analysis: { parameters: { sender: "string", limit: "number" } },
            search_across_chats: { parameters: { query: "string", limit: "number" } },
        };
    }

    resetSession(): void {
        this.chat = null;
    }
}
