import { homedir } from "node:os";
import { resolve } from "node:path";
import { AIChat } from "@ask/AIChat";
import type { ActionHandler } from "../types";

/** Cache of AIChat instances per contact */
const contactChats = new Map<string, AIChat>();

export const handleAsk: ActionHandler = async (message, contact, client, conversationHistory) => {
    const start = performance.now();
    const typing = client.startTypingLoop(contact.userId);

    try {
        // Get or create AIChat instance for this contact
        let chat = contactChats.get(contact.userId);

        if (!chat) {
            chat = new AIChat({
                provider: contact.askProvider,
                model: contact.askModel,
                systemPrompt: contact.askSystemPrompt,
                logLevel: "silent",
                session: {
                    id: `telegram-${contact.userId}`,
                    dir: resolve(homedir(), ".genesis-tools/telegram/ai-sessions"),
                    autoSave: true,
                },
            });
            contactChats.set(contact.userId, chat);
        }

        // Build prompt with conversation history context
        let promptText: string;

        if (conversationHistory) {
            promptText =
                `[Recent conversation]\n${conversationHistory}\n\n` +
                `[New message from ${contact.displayName}]\n${message.contentForLLM}`;
        } else {
            promptText = message.contentForLLM;
        }

        const response = await chat.send(promptText);

        typing.stop();

        if (!response.content) {
            return {
                action: "ask",
                success: false,
                duration: performance.now() - start,
                error: "Empty LLM response",
            };
        }

        await Bun.sleep(contact.randomDelay);

        await client.sendMessage(contact.userId, response.content);

        return {
            action: "ask",
            success: true,
            reply: response.content,
            duration: performance.now() - start,
        };
    } catch (err) {
        typing.stop();

        return {
            action: "ask",
            success: false,
            duration: performance.now() - start,
            error: err,
        };
    }
};
