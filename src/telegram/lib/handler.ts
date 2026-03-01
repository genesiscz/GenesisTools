import logger from "@app/logger";
import pc from "picocolors";
import type { DeletedMessageEvent } from "telegram/events/DeletedMessage";
import type { EditedMessageEvent } from "telegram/events/EditedMessage";
import type { NewMessageEvent } from "telegram/events/NewMessage";
import { executeActions } from "./actions";
import { TelegramContact } from "./TelegramContact";
import type { TelegramHistoryStore } from "./TelegramHistoryStore";
import { TelegramMessage } from "./TelegramMessage";
import type { TGClient } from "./TGClient";
import type { ContactConfig } from "./types";
import { DEFAULTS } from "./types";

const processedIds = new Set<number>();
const processedOrder: number[] = [];

function trackMessage(id: number): boolean {
    if (processedIds.has(id)) {
        return false;
    }

    processedIds.add(id);
    processedOrder.push(id);

    while (processedOrder.length > DEFAULTS.maxProcessedMessages) {
        const oldest = processedOrder.shift();

        if (oldest !== undefined) {
            processedIds.delete(oldest);
        }
    }

    return true;
}

class ConversationContext {
    private lines: string[] = [];
    private maxLines: number;

    constructor(maxLines: number, initialLines?: string[]) {
        this.maxLines = maxLines;

        if (initialLines) {
            this.lines = initialLines.slice(-maxLines);
        }
    }

    append(name: string, content: string): void {
        this.lines.push(`${name}: ${content}`);

        while (this.lines.length > this.maxLines) {
            this.lines.shift();
        }
    }

    toString(): string {
        return this.lines.join("\n");
    }

    get isEmpty(): boolean {
        return this.lines.length === 0;
    }
}

function resolveTargetChatId(message: TelegramMessage): string | undefined {
    if (message.chatId) {
        return message.chatId;
    }

    if (message.senderId) {
        return message.senderId;
    }

    return undefined;
}

function resolveDeletedEventChatId(event: DeletedMessageEvent): string | undefined {
    const peer = event.peer;

    if (!peer) {
        return undefined;
    }

    if (typeof peer === "string") {
        return peer;
    }

    if (typeof peer !== "object" || peer === null) {
        return undefined;
    }

    if ("channelId" in peer && peer.channelId) {
        return String(peer.channelId);
    }

    if ("chatId" in peer && peer.chatId) {
        return String(peer.chatId);
    }

    if ("userId" in peer && peer.userId) {
        return String(peer.userId);
    }

    return undefined;
}

export interface HandlerOptions {
    contacts: ContactConfig[];
    myName: string;
    initialHistory?: Map<string, string[]>;
    store: TelegramHistoryStore;
}

export function registerHandler(client: TGClient, options: HandlerOptions): void {
    const contactMap = new Map<string, TelegramContact>();
    const contexts = new Map<string, ConversationContext>();

    for (const config of options.contacts) {
        const contact = TelegramContact.fromConfig(config);
        contactMap.set(config.userId, contact);

        const initial = options.initialHistory?.get(config.userId);
        contexts.set(config.userId, new ConversationContext(contact.contextLength, initial));
    }

    client.onNewMessage(async (event: NewMessageEvent) => {
        try {
            const message = new TelegramMessage(event.message);

            if (message.isOutgoing) {
                return;
            }

            const targetChatId = resolveTargetChatId(message);

            if (!targetChatId) {
                return;
            }

            const contact = contactMap.get(targetChatId);

            if (!contact) {
                return;
            }

            if (!trackMessage(message.id)) {
                return;
            }

            if (!message.hasText && !message.hasMedia) {
                return;
            }

            options.store.upsertMessageWithRevision(targetChatId, message.toJSON(), "create");

            const context = contexts.get(targetChatId);

            if (context) {
                context.append(contact.displayName, message.contentForLLM);
            }

            logger.info(`${pc.bold(pc.cyan(contact.displayName))}: ${message.preview}`);

            const history = context && !context.isEmpty ? context.toString() : undefined;
            const results = await executeActions(contact, message, client, history);

            for (const result of results) {
                if (result.success) {
                    const extra = result.reply
                        ? ` "${result.reply.slice(0, 60)}${result.reply.length > 60 ? "..." : ""}"`
                        : "";
                    logger.info(`  ${pc.green(`[${result.action}]`)} OK${pc.dim(extra)}`);

                    if (result.action === "ask" && result.reply && context) {
                        context.append(options.myName, result.reply);

                        if (result.sentMessageId) {
                            options.store.upsertMessageWithRevision(
                                targetChatId,
                                {
                                    id: result.sentMessageId,
                                    senderId: undefined,
                                    text: result.reply,
                                    mediaDescription: undefined,
                                    isOutgoing: true,
                                    date: new Date().toISOString(),
                                    dateUnix: Math.floor(Date.now() / 1000),
                                    attachments: [],
                                },
                                "create"
                            );
                        } else {
                            logger.warn(
                                `Auto-reply message id missing for ${targetChatId}; skipping outgoing persistence.`
                            );
                        }
                    }
                } else {
                    logger.warn(`  ${pc.red(`[${result.action}]`)} FAILED: ${result.error}`);
                }
            }
        } catch (err) {
            logger.error(`Handler error: ${err}`);
        }
    });

    client.onEditedMessage(async (event: EditedMessageEvent) => {
        try {
            const message = new TelegramMessage(event.message);
            const targetChatId = resolveTargetChatId(message);

            if (!targetChatId || !contactMap.has(targetChatId)) {
                return;
            }

            options.store.upsertMessageWithRevision(targetChatId, message.toJSON(), "edit");
            logger.info(`${pc.yellow("Edited")} ${pc.cyan(targetChatId)} #${message.id}`);
        } catch (err) {
            logger.warn(`Edit event handling failed: ${err}`);
        }
    });

    client.onDeletedMessage(async (event: DeletedMessageEvent) => {
        try {
            const eventChatId = resolveDeletedEventChatId(event);

            for (const messageId of event.deletedIds) {
                const candidateChats = eventChatId ? [eventChatId] : options.store.findChatsByMessageId(messageId);

                for (const chatId of candidateChats) {
                    if (!contactMap.has(chatId)) {
                        continue;
                    }

                    options.store.markMessageDeleted(chatId, messageId);
                    logger.info(`${pc.red("Deleted")} ${pc.cyan(chatId)} #${messageId}`);
                }
            }
        } catch (err) {
            logger.warn(`Delete event handling failed: ${err}`);
        }
    });

    const names = options.contacts.map((contact) => pc.cyan(contact.displayName)).join(", ");
    logger.info(`Listening for messages from ${options.contacts.length} contact(s): ${names}`);
}
