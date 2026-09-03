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
import type { NotifyTarget } from "./types";

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
            return typeof config.url === "string" ? config.url : "no url";
    }
}

/** Sends one event to one library target, with that target's own config. Never throws. */
export async function dispatchToTarget(target: NotifyTarget, event: NotificationEvent): Promise<void> {
    if (!target.enabled) {
        return;
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
    } catch (error) {
        logger.warn({ error, target: target.id, channel: target.channel }, "monitor: target dispatch failed");
    }
}

export async function dispatchToTargets(targets: NotifyTarget[], event: NotificationEvent): Promise<void> {
    await Promise.all(targets.map((target) => dispatchToTarget(target, event)));
}
