import { dispatchNotification } from "@genesiscz/utils/notifications";
import type { AlertChannel } from "../types";

/** The dashboard's `notifications` preferences this channel honours. */
export interface MacosChannelSettings {
    enabled: boolean;
    macos: boolean;
    sound: string;
}

/**
 * The macOS banner, through the shared notification door. `notifications.enabled` and `notifications.macos` off mean
 * the user asked for no banner, as they did for the old threshold notifier; `sound` is the dashboard's own pick.
 */
export function macosAlertChannel(settings: MacosChannelSettings): AlertChannel {
    return {
        id: "macos",
        interrupts: true,
        async deliver(alert) {
            if (!settings.enabled || !settings.macos) {
                return;
            }

            await dispatchNotification({
                app: "claude",
                title: alert.title,
                message: alert.message,
                group: "ai-usage",
                ...(settings.sound ? { sound: settings.sound } : {}),
            });
        },
    };
}
