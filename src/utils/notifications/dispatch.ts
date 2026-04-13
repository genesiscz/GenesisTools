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
            stderr: "pipe",
        });
        const [exitCode, stderrText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

        if (exitCode !== 0) {
            logger.warn({ exitCode, stderr: stderrText.trim() }, "Say notification dispatch failed");
        }
    } catch (err) {
        logger.warn({ err }, "Say notification dispatch failed");
    }
}

export async function dispatchNotification(event: NotificationEvent): Promise<void> {
    try {
        const channels = await notificationsConfig.getChannels(event.app);

        const channelNames = ["system", "telegram", "webhook", "say"] as const;
        const results = await Promise.allSettled([
            dispatchSystem(event, channels.system),
            dispatchTelegram(event, channels.telegram),
            dispatchWebhook(event, channels.webhook),
            dispatchSay(event.message, channels.say),
        ]);

        for (let i = 0; i < results.length; i++) {
            const r = results[i];

            if (r.status === "rejected") {
                logger.warn({ err: r.reason, app: event.app, channel: channelNames[i] }, "Channel dispatch failed");
            }
        }
    } catch (err) {
        logger.warn({ err, app: event.app }, "Notification dispatch failed");
    }
}
