import { logger } from "@genesiscz/utils/logger";
import {
    CHANNELS,
    type ChannelConfigs,
    type ChannelName,
    type NotificationEvent,
} from "@genesiscz/utils/notifications";
import type { NotifyTarget } from "./types";

export const NOTIFY_APP = "monitor";

/** A target's stored config is a loose bag checked against the channel's field list on write; here it is that config. */
function configOf<K extends ChannelName>(channel: K, target: NotifyTarget): ChannelConfigs[K] {
    return { ...CHANNELS[channel].defaults, ...target.config, enabled: true } as ChannelConfigs[K];
}

function describeAs<K extends ChannelName>(channel: K, target: NotifyTarget): string {
    return CHANNELS[channel].describe(configOf(channel, target));
}

/** One-line human summary of a target's config, secrets masked. */
export function describeTarget(target: NotifyTarget): string {
    return describeAs(target.channel, target);
}

async function sendAs<K extends ChannelName>(channel: K, target: NotifyTarget, event: NotificationEvent) {
    return (await CHANNELS[channel].post(event, configOf(channel, target))).ok;
}

function sendToChannel(target: NotifyTarget, event: NotificationEvent): Promise<boolean> {
    return sendAs(target.channel, target, event);
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
