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
 *
 * The door fans out to every channel the user turned on for the app (Telegram, a webhook, speech) unless told
 * otherwise, so it is told `only: ["system"]`: an alert sent to `macos` stays a banner, and the tick never waits on
 * the speech channel's deadline. Telegram or speech for alerts would be channels of their own.
 */
export function macosAlertChannel(
    settings: MacosChannelSettings,
    deps: { dispatch?: typeof dispatchNotification } = {}
): AlertChannel {
    const dispatch = deps.dispatch ?? dispatchNotification;

    return {
        id: "macos",
        interrupts: true,
        async deliver(alert) {
            if (!settings.enabled || !settings.macos) {
                return;
            }

            await dispatch({
                app: "claude",
                title: alert.title,
                message: alert.message,
                group: "ai-usage",
                ...(settings.sound ? { sound: settings.sound } : {}),
                only: ["system"],
            });
        },
    };
}
