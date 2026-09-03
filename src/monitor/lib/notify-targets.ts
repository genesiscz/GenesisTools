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

function sendToChannel(target: NotifyTarget, event: NotificationEvent): Promise<boolean> {
    const config = { ...target.config, enabled: true };

    switch (target.channel) {
        case "system":
            return dispatchSystem(event, config as SystemChannelConfig);
        case "say":
            return dispatchSay(event.message, config as SayChannelConfig);
        case "telegram":
            return dispatchTelegram(event, config as TelegramChannelConfig);
        case "webhook":
            return dispatchWebhook(event, config as WebhookChannelConfig);
    }
}

/**
 * Sends one event to one library target, with that target's own config. Never
 * throws. True when the channel accepted the event.
 */
export async function dispatchToTarget(target: NotifyTarget, event: NotificationEvent): Promise<boolean> {
    if (!target.enabled) {
        return true;
    }

    try {
        // Every channel reports its own outcome instead of throwing (a webhook
        // that answers 500 logs and returns false), so a dead endpoint has to be
        // read off the return value or the feed retry never fires.
        const sent = await sendToChannel(target, event);

        if (!sent) {
            logger.warn({ target: target.id, channel: target.channel }, "monitor: target did not accept the event");

            return false;
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

/**
 * False when a selected target id no longer resolves to a row. The foreign key
 * on `watcher_targets` cascades a delete, so the only way to get here is a
 * watcher object loaded before that delete landed: counting the send as
 * delivered would drop the notification instead of retrying it.
 */
export function allTargetsResolved(requestedIds: number[], resolved: NotifyTarget[]): boolean {
    const found = new Set(resolved.map((target) => target.id));

    return requestedIds.every((id) => found.has(id));
}
