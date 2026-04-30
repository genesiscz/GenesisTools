import { speakWithProfile } from "@app/say/lib/speak";
import type { ActionHandler } from "../types";

export const handleSay: ActionHandler = async (message, contact) => {
    const start = performance.now();

    const text = message.mediaDescription
        ? `${contact.displayName} sent ${message.mediaDescription}`
        : `${contact.displayName} says: ${message.text}`;

    try {
        await speakWithProfile({ text });

        return {
            action: "say",
            success: true,
            duration: performance.now() - start,
        };
    } catch (err) {
        return {
            action: "say",
            success: false,
            duration: performance.now() - start,
            error: err,
        };
    }
};
