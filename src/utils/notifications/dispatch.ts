import { logger } from "@genesiscz/utils/logger";
import { CHANNEL_NAMES, CHANNELS } from "./channels";
import { notificationsConfig } from "./config";
import { recordNotification } from "./ledger";
import type { ChannelConfigs, ChannelName, ChannelReceipt, NotificationEvent } from "./types";

export { dispatchSay, SAY_DISPATCH_TIMEOUT_MS } from "./channels/say";

type Channels = Awaited<ReturnType<typeof notificationsConfig.getChannels>>;

/** A channel switched on without what it needs to send: its ledger line says suppressed, not failed. */
export function unconfiguredChannel(name: ChannelName, channels: Channels): boolean {
    return unusableReason(name, channels) !== undefined;
}

function unusableReason<K extends ChannelName>(name: K, channels: ChannelConfigs): string | undefined {
    return CHANNELS[name].unusable(channels[name]);
}

function postTo<K extends ChannelName>(
    name: K,
    event: NotificationEvent,
    channels: ChannelConfigs
): Promise<ChannelReceipt> {
    return CHANNELS[name].post(event, channels[name]);
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

        const results = await Promise.allSettled(
            CHANNEL_NAMES.map((name) =>
                allows(name) ? postTo(name, event, channels) : Promise.resolve<ChannelReceipt>({ ok: true })
            )
        );
        let delivered = true;

        for (const [i, r] of results.entries()) {
            const name = CHANNEL_NAMES[i];
            // The system channel records itself in postNotification, with the backend it used.
            if (name !== "system" && allows(name) && channels[name].enabled) {
                const unusable =
                    unusableReason(name, channels) ?? (r.status === "fulfilled" ? r.value.suppressed : undefined);
                await recordNotification({
                    source: event.app,
                    channel: name,
                    outcome: unusable ? "suppressed" : r.status === "fulfilled" && r.value.ok ? "posted" : "failed",
                    ...(unusable ? { reason: unusable } : {}),
                    ...(r.status === "fulfilled" && r.value.detail ? { detail: r.value.detail } : {}),
                    title: event.title,
                    body: event.message,
                });
            }

            if (r.status === "rejected") {
                logger.warn({ err: r.reason, app: event.app, channel: name }, "Channel dispatch failed");
                delivered = false;
                continue;
            }

            delivered = delivered && r.value.ok;
        }

        return delivered;
    } catch (err) {
        logger.warn({ err, app: event.app }, "Notification dispatch failed");

        return false;
    }
}
