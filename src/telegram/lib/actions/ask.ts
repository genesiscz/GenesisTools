import { runTool } from "@app/utils/cli/tools";
import type { ActionHandler } from "../types";
import { DEFAULTS } from "../types";

export const handleAsk: ActionHandler = async (message, contact, client, conversationHistory) => {
    const start = performance.now();
    const typing = client.startTypingLoop(contact.userId);

    try {
        const systemPrompt = contact.askSystemPrompt;

        let promptText: string;

        if (conversationHistory) {
            promptText =
                `[Recent conversation]\n${conversationHistory}\n\n` +
                `[New message from ${contact.displayName}]\n${message.contentForLLM}`;
        } else {
            promptText = message.contentForLLM;
        }

        const result = await runTool(
            [
                "ask",
                "-p",
                contact.askProvider,
                "-m",
                contact.askModel,
                "--system-prompt",
                systemPrompt,
                "--no-streaming",
                "--raw",
                "--",
                promptText,
            ],
            { timeout: DEFAULTS.askTimeoutMs }
        );

        typing.stop();

        if (!result.success || !result.stdout) {
            return {
                action: "ask",
                success: false,
                duration: performance.now() - start,
                error: result.stderr || "Empty LLM response",
            };
        }

        await Bun.sleep(contact.randomDelay);

        await client.sendMessage(contact.userId, result.stdout);

        return {
            action: "ask",
            success: true,
            reply: result.stdout,
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
