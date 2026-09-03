import { logger } from "@genesiscz/utils/logger";
import {
    dispatchSay,
    dispatchSystem,
    dispatchTelegram,
    dispatchWebhook,
    type NotificationEvent,
    type SayChannelConfig,
    type SystemChannelConfig,
    type TelegramChannelConfig,
    type WebhookChannelConfig,
} from "@genesiscz/utils/notifications";
import { type NotifyTarget, webhookHost } from "./types";

export const NOTIFY_APP = "monitor";

/** One-line human summary of a target's config, secrets masked. */
export function describeTarget(target: NotifyTarget): string {
    const config = target.config;

    switch (target.channel) {
        case "system":
            return [
                config.title,
                config.sound ? `sound ${config.sound}` : null,
                config.ignoreDnD ? "bypasses DnD" : null,
            ]
                .filter(Boolean)
                .join(" · ");
        case "say":
            return [
                config.voice ? `voice ${config.voice}` : "default voice",
                config.provider ? `via ${config.provider}` : null,
            ]
                .filter(Boolean)
                .join(" · ");
        case "telegram":
            return `chat ${config.chatId ?? "?"} · token ${config.botToken ? "set" : "missing"}`;
        case "webhook":
            return webhookHost(config.url) ?? "no url";
    }
}

/** Sends one event to one library target, with that target's own config. Never throws. */
/** True when the channel accepted the event; false when its dispatcher threw. */
export async function dispatchToTarget(target: NotifyTarget, event: NotificationEvent): Promise<boolean> {
    if (!target.enabled) {
        return true;
    }

    const config = { ...target.config, enabled: true };

    try {
        switch (target.channel) {
            case "system":
                await dispatchSystem(event, config as SystemChannelConfig);
                break;
            case "say":
                await dispatchSay(event.message, config as SayChannelConfig);
                break;
            case "telegram":
                await dispatchTelegram(event, config as TelegramChannelConfig);
                break;
            case "webhook":
                await dispatchWebhook(event, config as WebhookChannelConfig);
                break;
        }

        logger.debug({ target: target.id, channel: target.channel, title: event.title }, "monitor: target notified");

        return true;
    } catch (error) {
        logger.warn({ error, target: target.id, channel: target.channel }, "monitor: target dispatch failed");

        return false;
    }
}

/** True only when every target accepted the event. */
export async function dispatchToTargets(targets: NotifyTarget[], event: NotificationEvent): Promise<boolean> {
    const results = await Promise.all(targets.map((target) => dispatchToTarget(target, event)));

    return results.every(Boolean);
}
