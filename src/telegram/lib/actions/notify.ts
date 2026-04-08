import { dispatchNotification } from "@app/utils/notifications";
import type { ActionHandler } from "../types";

export const handleNotify: ActionHandler = async (message, contact) => {
    const start = performance.now();

    const body = message.mediaDescription ? `[${message.mediaDescription}] ${message.text}`.trim() : message.text;

    dispatchNotification({
        app: "telegram",
        title: `Telegram: ${contact.displayName}`,
        message: body || "(empty message)",
    });

    return {
        action: "notify",
        success: true,
        duration: performance.now() - start,
    };
};
