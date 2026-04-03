import logger from "@app/logger";
import { dispatchSystem } from "./channels/system";
import { dispatchTelegram } from "./channels/telegram";
import { dispatchWebhook } from "./channels/webhook";
import { notificationsConfig } from "./config";
import type { NotificationEvent, SayChannelConfig } from "./types";

async function dispatchSay(message: string, config: SayChannelConfig): Promise<void> {
    if (!config.enabled) {
        return;
    }

    const voice = config.voice ?? "Samantha";

    try {
        const proc = Bun.spawn(["tools", "say", message, "--voice", voice], {
            stdout: "ignore",
            stderr: "ignore",
        });
        await proc.exited;
    } catch (err) {
        logger.warn({ err }, "Say notification dispatch failed");
    }
}

export async function dispatchNotification(event: NotificationEvent): Promise<void> {
    try {
        const channels = await notificationsConfig.getChannels(event.app);

        await Promise.allSettled([
            dispatchSystem(event, channels.system),
            dispatchTelegram(event, channels.telegram),
            dispatchWebhook(event, channels.webhook),
            dispatchSay(event.message, channels.say),
        ]);
    } catch (err) {
        logger.warn({ err, app: event.app }, "Notification dispatch failed");
    }
}
