import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import type { NotificationEvent, SystemChannelConfig } from "../types";

/** True when the banner was handed to the OS (or there was nothing to send). Never throws. */
export async function dispatchSystem(event: NotificationEvent, config: SystemChannelConfig): Promise<boolean> {
    if (!config.enabled || process.platform !== "darwin") {
        return true;
    }

    try {
        await sendNotification({
            title: event.title ?? config.title ?? "GenesisTools",
            message: event.message,
            subtitle: event.subtitle,
            sound: event.sound ?? config.sound,
            group: event.group ?? event.app,
            open: event.open,
            execute: event.execute,
            appIcon: event.appIcon,
            ignoreDnD: event.ignoreDnD ?? config.ignoreDnD,
        });

        return true;
    } catch (err) {
        logger.warn({ err, app: event.app }, "System notification dispatch failed");

        return false;
    }
}
