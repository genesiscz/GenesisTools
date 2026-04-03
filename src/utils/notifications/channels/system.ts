import { sendNotification } from "@app/utils/macos/notifications";
import type { NotificationEvent, SystemChannelConfig } from "../types";

export async function dispatchSystem(event: NotificationEvent, config: SystemChannelConfig): Promise<void> {
    if (!config.enabled) {
        return;
    }

    await sendNotification({
        title: event.title ?? config.title ?? "GenesisTools",
        message: event.message,
        subtitle: event.subtitle,
        sound: config.sound,
        group: event.group ?? event.app,
        open: event.open,
        execute: event.execute,
        ignoreDnD: config.ignoreDnD,
    });
}
