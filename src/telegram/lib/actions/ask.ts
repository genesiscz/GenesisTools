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
        // Get or create AIChat instance — cache key includes config so changes are detected
        const cacheKey = `${contact.userId}:${contact.askProvider}:${contact.askModel}`;
        let chat = contactChats.get(cacheKey);

        if (!chat) {
            // Clean up old instance for this user if config changed
            for (const [key, oldChat] of contactChats) {
                if (key.startsWith(`${contact.userId}:`)) {
                    oldChat.dispose();
                    contactChats.delete(key);
                }
            }

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
            contactChats.set(cacheKey, chat);
        }

        // Add conversation history as context if available, then send only the new message.
        // Using addToHistory: false for the context to avoid duplicating history in the session.
        if (conversationHistory) {
            chat.session.add({ role: "system", content: `[Recent conversation]\n${conversationHistory}` });
        }

        const response = await chat.send(message.contentForLLM);

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
