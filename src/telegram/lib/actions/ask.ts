import { assistantEngine } from "../AssistantEngine";
import type { ActionHandler } from "../types";

export const handleAsk: ActionHandler = async (message, contact, client, conversationHistory) => {
    const start = performance.now();
    const typing = client.startTypingLoop(contact.userId);

    try {
        const mode = contact.autoReplyMode;

        if (!mode.enabled) {
            typing.stop();

            return {
                action: "ask",
                success: true,
                duration: performance.now() - start,
            };
        }

        const response = await assistantEngine.ask({
            sessionId: `telegram-${contact.userId}-autoreply`,
            mode,
            incomingText: message.contentForLLM,
            conversationHistory,
            stylePrompt: contact.config.styleProfile?.derivedPrompt,
        });

        typing.stop();

        if (!response) {
            return {
                action: "ask",
                success: false,
                duration: performance.now() - start,
                error: "Empty LLM response",
            };
        }

        await Bun.sleep(contact.randomDelay);

        const sent = await client.sendMessage(contact.userId, response);

        return {
            action: "ask",
            success: true,
            reply: response,
            sentMessageId: sent.id,
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
