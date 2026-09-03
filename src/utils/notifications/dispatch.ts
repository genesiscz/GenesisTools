import { logger } from "@genesiscz/utils/logger";
import { dispatchSystem } from "./channels/system";
import { dispatchTelegram } from "./channels/telegram";
import { dispatchWebhook } from "./channels/webhook";
import { notificationsConfig } from "./config";
import type { ChannelName, NotificationEvent, SayChannelConfig } from "./types";

/** True when `tools say` spoke the message (or there was nothing to say). Never throws. */
export async function dispatchSay(message: string, config: SayChannelConfig): Promise<boolean> {
    if (!config.enabled) {
        return true;
    }

    const voice = config.voice ?? "Samantha";
    const args = ["tools", "say", message, "--voice", voice];

    if (config.provider) {
        args.push("--provider", config.provider);
    }

    try {
        const proc = Bun.spawn(args, {
            stdout: "ignore",
            stderr: "pipe",
        });
        const [exitCode, stderrText] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

        if (exitCode !== 0) {
            logger.warn({ exitCode, stderr: stderrText.trim() }, "Say notification dispatch failed");
        }

        return exitCode === 0;
    } catch (err) {
        logger.warn({ err }, "Say notification dispatch failed");

        return false;
    }
}

/**
 * True when every channel that was asked to send accepted the event. A channel
 * that is switched off, or excluded by `event.only`, counts as accepted: there
 * was nothing to deliver. Callers that retry (monitor feed items) need that
 * distinction, so this never throws and never reports a silent drop as a send.
 */
export async function dispatchNotification(event: NotificationEvent): Promise<boolean> {
    try {
        const channels = await notificationsConfig.getChannels(event.app);
        const only = event.only;
        const allows = (name: ChannelName): boolean => only === undefined || only.includes(name);

        const channelNames = ["system", "telegram", "webhook", "say"] as const;
        const results = await Promise.allSettled([
            allows("system") ? dispatchSystem(event, channels.system) : Promise.resolve(true),
            allows("telegram") ? dispatchTelegram(event, channels.telegram) : Promise.resolve(true),
            allows("webhook") ? dispatchWebhook(event, channels.webhook) : Promise.resolve(true),
            allows("say") ? dispatchSay(event.message, channels.say) : Promise.resolve(true),
        ]);
        let delivered = true;

        for (let i = 0; i < results.length; i++) {
            const r = results[i];

            if (r.status === "rejected") {
                logger.warn({ err: r.reason, app: event.app, channel: channelNames[i] }, "Channel dispatch failed");
                delivered = false;
                continue;
            }

            delivered = delivered && r.value;
        }

        return delivered;
    } catch (err) {
        logger.warn({ err, app: event.app }, "Notification dispatch failed");

        return false;
    }
}
