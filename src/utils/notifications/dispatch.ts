import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { dispatchSystem } from "./channels/system";
import { dispatchTelegram } from "./channels/telegram";
import { dispatchWebhook } from "./channels/webhook";
import { notificationsConfig } from "./config";
import { recordNotification } from "./ledger";
import type { ChannelName, NotificationEvent, SayChannelConfig } from "./types";

/**
 * How long `tools say` may run before its process group is stopped. Speaking a notification takes seconds. A run past
 * this is stuck: a child that never exits, or one that left a grandchild holding its stderr pipe open, and without a
 * deadline every caller of {@link dispatchNotification} waited on it forever.
 */
export const SAY_DISPATCH_TIMEOUT_MS = 120_000;

/** True when `tools say` spoke the message (or there was nothing to say). Never throws. */
export async function dispatchSay(
    message: string,
    config: SayChannelConfig,
    { timeoutMs = SAY_DISPATCH_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<boolean> {
    if (!config.enabled) {
        return true;
    }

    const voice = config.voice ?? "Samantha";
    const args = ["tools", "say", message, "--voice", voice];

    if (config.provider) {
        args.push("--provider", config.provider);
    }

    try {
        const result = await boundedCommand({ command: args, timeoutMs });

        if (result.error || result.status !== 0) {
            logger.warn(
                { err: result.error, exitCode: result.status, signal: result.signal, stderr: result.stderr.trim() },
                "Say notification dispatch failed"
            );
            return false;
        }

        return true;
    } catch (err) {
        logger.warn({ err }, "Say notification dispatch failed");

        return false;
    }
}

type Channels = Awaited<ReturnType<typeof notificationsConfig.getChannels>>;

/** A channel switched on without what it needs to send: its ledger line says suppressed, not failed. */
export function unconfiguredChannel(name: ChannelName, channels: Channels): boolean {
    return (
        (name === "telegram" && (!channels.telegram.botToken || !channels.telegram.chatId)) ||
        (name === "webhook" && !channels.webhook.url)
    );
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

        if (allows("system") && !channels.system.enabled) {
            await recordNotification({
                source: event.app,
                channel: "macos",
                outcome: "suppressed",
                reason: "system channel off in notifications config",
                title: event.title,
                body: event.message,
            });
        }

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
            const unconfigured = unconfiguredChannel(channelNames[i], channels);
            // The system channel records itself in postNotification, with the backend it used.
            if (channelNames[i] !== "system" && allows(channelNames[i]) && channels[channelNames[i]].enabled) {
                await recordNotification({
                    source: event.app,
                    channel: channelNames[i],
                    outcome: unconfigured ? "suppressed" : r.status === "fulfilled" && r.value ? "posted" : "failed",
                    ...(unconfigured ? { reason: "channel enabled but not configured" } : {}),
                    title: event.title,
                    body: event.message,
                });
            }

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
