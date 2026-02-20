import logger from "@app/logger";
import pc from "picocolors";
import type { NewMessageEvent } from "telegram/events";
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

/**
 * Per-contact conversation context buffer.
 * Stores formatted "Name: message" lines for LLM context.
 */
class ConversationContext {
    private lines: string[] = [];

    constructor(initialLines?: string[]) {
        if (initialLines) {
            this.lines = initialLines.slice(-DEFAULTS.maxContextMessages);
        }
    }

    append(name: string, content: string): void {
        this.lines.push(`${name}: ${content}`);

        while (this.lines.length > DEFAULTS.maxContextMessages) {
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
        contexts.set(config.userId, new ConversationContext(initial));
    }

    client.onNewMessage(async (event: NewMessageEvent) => {
        try {
            const msg = new TelegramMessage(event.message);

            if (!msg.isPrivate || msg.isOutgoing) {
                return;
            }

            const senderId = msg.senderId;

            if (!senderId) {
                return;
            }

            const contact = contactMap.get(senderId);

            if (!contact) {
                return;
            }

            if (!trackMessage(msg.id)) {
                return;
            }

            if (!msg.hasText && !msg.hasMedia) {
                return;
            }

            // Persist incoming message to history store
            try {
                options.store.insertMessages(senderId, [msg.toJSON()]);
            } catch (err) {
                logger.debug(`Failed to persist message: ${err}`);
            }

            // Append incoming message to conversation context
            const ctx = contexts.get(senderId);

            if (ctx) {
                ctx.append(contact.displayName, msg.contentForLLM);
            }

            logger.info(`${pc.bold(pc.cyan(contact.displayName))}: ${msg.preview}`);

            const history = ctx && !ctx.isEmpty ? ctx.toString() : undefined;
            const results = await executeActions(contact, msg, client, history);

            for (const r of results) {
                if (r.success) {
                    const extra = r.reply ? ` "${r.reply.slice(0, 60)}${r.reply.length > 60 ? "..." : ""}"` : "";
                    logger.info(`  ${pc.green(`[${r.action}]`)} OK${pc.dim(extra)}`);

                    // Append our reply to the conversation context
                    if (r.action === "ask" && r.reply && ctx) {
                        ctx.append(options.myName, r.reply);

                        // Persist outgoing reply to history store
                        try {
                            options.store.insertMessages(senderId, [
                                {
                                    id: Date.now(),
                                    senderId: undefined,
                                    text: r.reply,
                                    mediaDescription: undefined,
                                    isOutgoing: true,
                                    date: new Date().toISOString(),
                                    dateUnix: Math.floor(Date.now() / 1000),
                                },
                            ]);
                        } catch (err) {
                            logger.debug(`Failed to persist reply: ${err}`);
                        }
                    }
                } else {
                    logger.warn(`  ${pc.red(`[${r.action}]`)} FAILED: ${r.error}`);
                }
            }
        } catch (err) {
            logger.error(`Handler error: ${err}`);
        }
    });

    const names = options.contacts.map((c) => pc.cyan(c.displayName)).join(", ");
    logger.info(`Listening for messages from ${options.contacts.length} contact(s): ${names}`);
}
