import { logger } from "@genesiscz/utils/logger";
import { type PostedNotification, sendNotification } from "@genesiscz/utils/macos/notifications";
import type { NotificationEvent, SystemChannelConfig } from "../types";

/** Whether a posted banner counts as delivered for this event; see {@link NotificationEvent.requireConfirmed}. */
export function systemChannelDelivered(
    posted: Pick<PostedNotification, "confirmed">,
    event: Pick<NotificationEvent, "requireConfirmed">
): boolean {
    return posted.confirmed || !event.requireConfirmed;
}

/** True when the banner was handed to the OS (or there was nothing to send), confirmed when the event requires it. Never throws. */
export async function dispatchSystem(event: NotificationEvent, config: SystemChannelConfig): Promise<boolean> {
    if (!config.enabled || process.platform !== "darwin") {
        return true;
    }

    try {
        const posted = await sendNotification({
            title: event.title ?? config.title ?? "GenesisTools",
            message: event.message,
            subtitle: event.subtitle,
            sound: event.sound ?? config.sound,
            group: event.group ?? event.app,
            open: event.open,
            execute: event.execute,
            appIcon: event.appIcon,
            ignoreDnD: event.ignoreDnD ?? config.ignoreDnD,
            id: event.id,
            actions: event.actions,
        });

        return systemChannelDelivered(posted, event);
    } catch (err) {
        logger.warn({ err, app: event.app }, "System notification dispatch failed");

        return false;
    }
}
