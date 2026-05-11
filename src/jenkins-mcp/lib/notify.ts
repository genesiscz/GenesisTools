import { NotificationBackend, sendNotification } from "@app/utils/macos/notifications";

export interface SendOpts {
    title: string;
    subtitle?: string;
    body: string;
    sound?: string;
    /** Stable per-build id so notifications collapse instead of stacking. */
    group: string;
    /** URL opened on click — baked into the notification at OS level. */
    openUrl?: string;
}

/**
 * Routes through `@app/utils/macos/notifications.sendNotification` with
 * `preferred: NotificationBackend.TerminalNotifier` — bakes the click
 * action into the notification at OS level so clicks fire reliably even
 * after the monitor process exits.
 *
 * Falls through gracefully if terminal-notifier is missing (sendNotification
 * has its own backend chain).
 */
export class MonitorNotifier {
    async send(opts: SendOpts): Promise<void> {
        await sendNotification({
            title: opts.title,
            subtitle: opts.subtitle,
            message: opts.body,
            sound: opts.sound,
            group: opts.group,
            open: opts.openUrl,
            preferred: NotificationBackend.TerminalNotifier,
        });
    }
}
